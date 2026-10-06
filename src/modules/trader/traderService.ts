import { TradeRepository, TradeRecord } from '../../database/repositories/tradeRepository';
import { appSettings } from '../../config/settings';

export interface OrderRequest {
  userId: number;
  tokenMint: string;
  tokenSymbol: string;
  solAmount: number;
  currentPriceUsd: number;
  isDryRun: boolean;
  source: 'MANUAL' | 'AUTOPILOT';
  slippageBps?: number;
}

import { WalletService } from '../wallet/walletService';
import { JupiterClient } from './jupiterClient';

export class TraderService {
  private readonly WSOL_MINT = 'So11111111111111111111111111111111111111112';

  constructor(
    private readonly tradeRepo: TradeRepository,
    private readonly walletService: WalletService,
    private readonly jupiterClient?: JupiterClient
  ) {}

  calculateDynamicSlippage(baseSlippageBps: number, priceImpactPct: number, maxSlippageBps: number): number {
    const dynamicBps = Math.round(baseSlippageBps + priceImpactPct * 120);
    return Math.min(dynamicBps, maxSlippageBps);
  }

  async executeOrder(req: OrderRequest): Promise<TradeRecord> {
    if (req.isDryRun) {
      // Paper Trading: Simulate execution with market price and config fee
      const tokenAmount = req.currentPriceUsd > 0 ? (req.solAmount * appSettings.PAPER_TRADE_SOL_PRICE) / req.currentPriceUsd : 0;
      return this.tradeRepo.createTrade({
        user_id: req.userId,
        token_mint: req.tokenMint,
        token_symbol: req.tokenSymbol,
        side: 'BUY',
        source: req.source,
        is_dry_run: true,
        sol_amount: req.solAmount,
        token_amount: tokenAmount,
        entry_price_usd: req.currentPriceUsd,
        fee_lamports: appSettings.PAPER_TRADE_FEE_LAMPORTS,
        status: 'OPEN',
      });
    }

    if (!this.jupiterClient) {
      throw new Error('Jupiter client required for live trade execution');
    }

    // Live Trading Execution via Jupiter
    const wallet = await this.walletService.getOrCreateWallet(req.userId);
    const balance = await this.walletService.getBalance(wallet.publicKey);
    
    // Check if enough SOL for swap + fees. (Keep 0.005 SOL for safety).
    if (balance.sol < req.solAmount + 0.005) {
      throw new Error(`Saldo SOL tidak cukup. Balance: ${balance.sol.toFixed(4)}, Req: ${req.solAmount} + 0.005 (safety fee)`);
    }

    const amountLamports = Math.floor(req.solAmount * 1_000_000_000);
    const slippageBps = req.slippageBps || appSettings.DEFAULT_SLIPPAGE_BPS;

    const quote = await this.jupiterClient.getQuote(
      this.WSOL_MINT,
      req.tokenMint,
      amountLamports,
      slippageBps
    );

    const transaction = await this.jupiterClient.getSwapTransaction(quote, wallet.publicKey);

    // Sign and send via WalletService safely
    const signature = await this.walletService.signAndSendVersionedTransaction(req.userId, transaction);

    const outAmount = parseInt(quote.outAmount);
    // Rough estimate (need decimals for exact), assuming 6 for meme coins. 
    // Jupiter API outAmount includes decimals. Let's use current price for rough token amount in DB record:
    const tokenAmount = req.currentPriceUsd > 0 ? (req.solAmount * appSettings.PAPER_TRADE_SOL_PRICE) / req.currentPriceUsd : outAmount / 1_000_000;

    return this.tradeRepo.createTrade({
      user_id: req.userId,
      token_mint: req.tokenMint,
      token_symbol: req.tokenSymbol,
      side: 'BUY',
      source: req.source,
      is_dry_run: false,
      sol_amount: req.solAmount,
      token_amount: tokenAmount,
      entry_price_usd: req.currentPriceUsd,
      fee_lamports: 0, // fee is abstracted in Jupiter swap
      status: 'OPEN',
      tx_signature: signature,
    });
  }

  async closePosition(trade: TradeRecord, currentPriceUsd: number, percentageToClose: number = 100): Promise<void> {
    if (!trade.id) throw new Error('Trade ID is missing');
    if (trade.status !== 'OPEN' && trade.status !== 'PARTIAL_EXIT') return;
    if (percentageToClose <= 0 || percentageToClose > 100) throw new Error('Invalid percentage');

    const isPartial = percentageToClose < 100;
    const amountToClose = trade.token_amount * (percentageToClose / 100);

    let signature = null;
    let exitPrice = currentPriceUsd;

    if (trade.is_dry_run) {
      // Paper Trading close
    } else {
      if (!this.jupiterClient) throw new Error('Jupiter client required for live trade execution');
      
      const wallet = await this.walletService.getOrCreateWallet(trade.user_id);
      
      // Calculate token amount in raw integer (base units) exactly from RPC to avoid dust or decimals mismatch
      const totalTokenBalance = await this.walletService.getTokenBalance(wallet.publicKey, trade.token_mint);
      if (totalTokenBalance === 0) {
        throw new Error('Token balance is 0. Cannot close position.');
      }

      const amountLamports = Math.floor(totalTokenBalance * (percentageToClose / 100));
      if (amountLamports <= 0) {
        throw new Error('Calculated token amount to close is 0.');
      }

      // Swap from TOKEN to WSOL
      const quote = await this.jupiterClient.getQuote(
        trade.token_mint,
        this.WSOL_MINT,
        amountLamports,
        appSettings.DEFAULT_SLIPPAGE_BPS // possibly higher slippage for exit?
      );

      const transaction = await this.jupiterClient.getSwapTransaction(quote, wallet.publicKey);
      signature = await this.walletService.signAndSendVersionedTransaction(trade.user_id, transaction);
      
      // We could calculate actual exit price from quote.outAmount vs amountToClose
    }

    const pnlPercent = ((exitPrice - trade.entry_price_usd) / trade.entry_price_usd) * 100;
    
    // Simplistic PNL calc for now
    const pnlSol = trade.sol_amount * (pnlPercent / 100) * (percentageToClose / 100);

    const newStatus = isPartial ? 'PARTIAL_EXIT' : 'CLOSED';
    
    await this.tradeRepo.updateTradeStatus(trade.id, {
      status: newStatus,
      exit_price_usd: exitPrice,
      pnl_percent: pnlPercent,
      pnl_sol: pnlSol,
      closed_at: new Date().toISOString(),
      tx_signature: signature || trade.tx_signature,
    });
  }
}
