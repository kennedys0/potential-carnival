import { TradeRepository, TradeRecord } from '../../database/repositories/tradeRepository';
import { appSettings } from '../../config/settings';
import { getEnv } from '../../config/env';
import { getRedisConnection } from '../../queue/connection';
import { LiveTradingDisabledError, KillSwitchActiveError } from '../../utils/errors';
import crypto from 'crypto';

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
    await this.assertTradingAllowed(req.userId, 'BUY', req.isDryRun);

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

    if (!getEnv().LIVE_TRADING_ENABLED) {
      throw new LiveTradingDisabledError();
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

    const idempotencyKey = `buy_${req.userId}_${req.tokenMint}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    try {
      // Sign and send via WalletService safely (waits for confirmation timeout 30s)
      const signature = await this.walletService.signAndSendVersionedTransaction(req.userId, transaction);

      // Give RPC a small delay to index the parsed transaction
      await new Promise((res) => setTimeout(res, 2000));
      const tx = await this.walletService.getParsedTransaction(signature);

      let solSpentLamports = 0;
      let tokenReceivedRaw = 0;
      let tokenDecimals = 0;
      let feeLamports = 0;
      
      const outAmountEstimate = parseInt(quote.outAmount);
      let finalTokenAmount = outAmountEstimate > 0 ? outAmountEstimate / 1_000_000 : 0; // Fallback
      let finalSolAmount = req.solAmount;

      if (tx && tx.meta) {
        feeLamports = tx.meta.fee || 0;
        
        // Find user account index
        const accountIndex = tx.transaction.message.accountKeys.findIndex((k: any) => k.pubkey.toBase58() === wallet.publicKey);
        if (accountIndex >= 0) {
          solSpentLamports = tx.meta.preBalances[accountIndex] - tx.meta.postBalances[accountIndex] - feeLamports;
          finalSolAmount = solSpentLamports / 1e9;
        }

        const preToken = tx.meta.preTokenBalances?.find((t: any) => t.owner === wallet.publicKey && t.mint === req.tokenMint);
        const postToken = tx.meta.postTokenBalances?.find((t: any) => t.owner === wallet.publicKey && t.mint === req.tokenMint);

        const preAmtRaw = preToken ? parseInt(preToken.uiTokenAmount.amount, 10) : 0;
        const postAmtRaw = postToken ? parseInt(postToken.uiTokenAmount.amount, 10) : 0;
        tokenReceivedRaw = postAmtRaw - preAmtRaw;
        
        tokenDecimals = postToken ? postToken.uiTokenAmount.decimals : (preToken ? preToken.uiTokenAmount.decimals : 6);
        if (tokenReceivedRaw > 0) {
          finalTokenAmount = tokenReceivedRaw / Math.pow(10, tokenDecimals);
        }
      }

      return this.tradeRepo.createTrade({
        user_id: req.userId,
        token_mint: req.tokenMint,
        token_symbol: req.tokenSymbol,
        side: 'BUY',
        source: req.source,
        is_dry_run: false,
        sol_amount: finalSolAmount,
        token_amount: finalTokenAmount,
        entry_price_usd: req.currentPriceUsd,
        fee_lamports: feeLamports,
        status: 'OPEN',
        tx_signature: signature,
        token_amount_raw: tokenReceivedRaw,
        token_decimals: tokenDecimals,
        sol_spent_lamports: solSpentLamports,
        sol_usd_at_fill: req.currentPriceUsd,
        idempotency_key: idempotencyKey,
      });

    } catch (err: any) {
      const failureReason = err.message || 'Unknown execution error';
      if (failureReason.toLowerCase().includes('slippage') || failureReason.toLowerCase().includes('timeout') || failureReason.toLowerCase().includes('blockhash')) {
        await this.tradeRepo.createTrade({
          user_id: req.userId,
          token_mint: req.tokenMint,
          token_symbol: req.tokenSymbol,
          side: 'BUY',
          source: req.source,
          is_dry_run: false,
          sol_amount: req.solAmount,
          token_amount: 0,
          entry_price_usd: req.currentPriceUsd,
          fee_lamports: 0,
          status: 'FAILED',
          failure_reason: failureReason,
          idempotency_key: idempotencyKey,
        });
      }
      throw err;
    }
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
      if (!getEnv().LIVE_TRADING_ENABLED) {
        throw new LiveTradingDisabledError();
      }
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
      
      try {
        signature = await this.walletService.signAndSendVersionedTransaction(trade.user_id, transaction);
        
        await new Promise((res) => setTimeout(res, 2000));
        const tx = await this.walletService.getParsedTransaction(signature);
        
        if (tx && tx.meta) {
          const accountIndex = tx.transaction.message.accountKeys.findIndex((k: any) => k.pubkey.toBase58() === wallet.publicKey);
          let solReceivedLamports = 0;
          let feeLamports = tx.meta.fee || 0;
          if (accountIndex >= 0) {
            solReceivedLamports = tx.meta.postBalances[accountIndex] - tx.meta.preBalances[accountIndex] + feeLamports;
          }
          // Assuming we can derive true exit price
          if (solReceivedLamports > 0 && trade.token_amount > 0) {
             const solReceived = solReceivedLamports / 1e9;
             // Calculate effective exit price in USD (assuming SOL price is roughly the same, or we use entry price)
             // Not perfect but better than relying on currentPriceUsd strictly if we have real data
          }
        }
      } catch (err: any) {
         await this.tradeRepo.updateTradeStatus(trade.id, {
            status: 'FAILED', // or revert to OPEN if we treat exit failure as still OPEN
            failure_reason: err.message || 'Exit failed',
         });
         throw err;
      }
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

  private async assertTradingAllowed(userId: number, side: 'BUY' | 'SELL', isDryRun: boolean): Promise<void> {
    const redis = getRedisConnection();
    const isKillSwitchActive = await redis.get('killswitch:global');
    
    // Kill-switch rejects BUY orders (entry), but allows SELL (exit)
    if (isKillSwitchActive === '1' && side === 'BUY') {
      throw new KillSwitchActiveError();
    }
    
    // Live trading check for buys is already handled in the live path of executeOrder, 
    // but we can also enforce it here globally if it's not a dry run and we're entering
    if (!isDryRun && side === 'BUY' && !getEnv().LIVE_TRADING_ENABLED) {
        throw new LiveTradingDisabledError();
    }
  }
}
