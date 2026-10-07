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

    const idempotencyKey = crypto.createHash('sha256').update(`buy_${req.userId}_${req.tokenMint}_${Math.floor(Date.now() / 60000)}`).digest('hex');

    let tradeRecord: TradeRecord;
    try {
      tradeRecord = await this.tradeRepo.createTrade({
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
        status: 'PENDING',
        idempotency_key: idempotencyKey,
      });
    } catch (e: any) {
       // Probably idempotency collision
       throw new Error(`Failed to create PENDING trade (idempotency/duplicate?): ${e.message}`);
    }

    try {
      // Sign and send via WalletService safely
      const result = await this.walletService.signAndSendVersionedTransaction(
        req.userId, 
        transaction,
        async (sig) => {
          if (tradeRecord.id) {
            await this.tradeRepo.updateTradeStatus(tradeRecord.id, { pending_signature: sig });
          }
        }
      );

      if (result.status === 'FAILED_ONCHAIN') {
        await this.tradeRepo.updateTradeStatus(tradeRecord.id!, {
          status: 'FAILED',
          failure_reason: `On-chain failure: ${JSON.stringify(result.err)}`,
        });
        throw new Error('On-chain transaction failed');
      }

      if (result.status === 'UNKNOWN') {
        // Leave as PENDING for reconciliation
        return tradeRecord;
      }

      const signature = result.signature;

      // Give RPC a small delay to index the parsed transaction
      await new Promise((res) => setTimeout(res, 2000));
      const tx = await this.walletService.getParsedTransaction(signature);

      let solSpentLamports = 0;
      let tokenReceivedRaw = 0;
      let tokenDecimals = 0;
      let feeLamports = 0;
      
      let finalTokenAmount = 0;
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
      } else {
         // If we can't parse it yet, leave it to reconciliation to fix remaining_raw and token_amount
         // But we set OPEN status since it succeeded on-chain.
      }

      const updates: Partial<TradeRecord> = {
        status: 'OPEN',
        sol_amount: finalSolAmount,
        token_amount: finalTokenAmount,
        fee_lamports: feeLamports,
        tx_signature: signature,
        token_amount_raw: tokenReceivedRaw,
        token_decimals: tokenDecimals,
        sol_spent_lamports: solSpentLamports,
        remaining_raw: tokenReceivedRaw,
      };

      await this.tradeRepo.updateTradeStatus(tradeRecord.id!, updates);
      return { ...tradeRecord, ...updates };

    } catch (err: any) {
      const failureReason = err.message || 'Unknown execution error';
      // Only fail it if we are sure it didn't hit the network, otherwise keep PENDING
      // If signAndSendVersionedTransaction throws before sending, it's safe to FAILED.
      if (!tradeRecord.pending_signature) {
          await this.tradeRepo.updateTradeStatus(tradeRecord.id!, {
            status: 'FAILED',
            failure_reason: failureReason,
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

    if (trade.is_dry_run) {
      // Paper Trading close logic
      const pnlPercent = ((currentPriceUsd - trade.entry_price_usd) / trade.entry_price_usd) * 100;
      const pnlSol = trade.sol_amount * (pnlPercent / 100) * (percentageToClose / 100);
      const newStatus = isPartial ? 'PARTIAL_EXIT' : 'CLOSED';
      await this.tradeRepo.updateTradeStatus(trade.id, {
        status: newStatus,
        exit_price_usd: currentPriceUsd,
        pnl_percent: pnlPercent,
        pnl_sol: pnlSol,
        closed_at: new Date().toISOString(),
      });
      return;
    }

    if (!this.jupiterClient) throw new Error('Jupiter client required for live trade execution');
    const wallet = await this.walletService.getOrCreateWallet(trade.user_id);
    
    // Total token balance on chain
    const totalTokenBalance = await this.walletService.getTokenBalance(wallet.publicKey, trade.token_mint);
    if (totalTokenBalance === 0) {
      // If we are supposed to have tokens but balance is 0, mark closed
      await this.tradeRepo.updateTradeStatus(trade.id, {
        status: 'CLOSED',
        closed_at: new Date().toISOString(),
        needs_attention: true, // Needs attention because tokens disappeared unexpectedly
      });
      return;
    }

    const amountLamports = Math.floor(totalTokenBalance * (percentageToClose / 100));
    if (amountLamports <= 0) {
      throw new Error('Calculated token amount to close is 0.');
    }

    // Increment exit attempts immediately
    const currentAttempts = (trade.exit_attempts || 0) + 1;
    await this.tradeRepo.updateTradeStatus(trade.id, { exit_attempts: currentAttempts });

    const quote = await this.jupiterClient.getQuote(
      trade.token_mint,
      this.WSOL_MINT,
      amountLamports,
      appSettings.DEFAULT_SLIPPAGE_BPS 
    );

    const transaction = await this.jupiterClient.getSwapTransaction(quote, wallet.publicKey);
    
    let result;
    try {
      result = await this.walletService.signAndSendVersionedTransaction(
        trade.user_id, 
        transaction,
        async (sig) => {
          await this.tradeRepo.updateTradeStatus(trade.id!, { pending_signature: sig });
        }
      );
    } catch (e: any) {
      // Failed before sending
      await this.tradeRepo.updateTradeStatus(trade.id, {
        last_exit_error: e.message,
        needs_attention: currentAttempts >= 3,
      });
      throw e;
    }

    if (result.status === 'FAILED_ONCHAIN' || result.status === 'UNKNOWN') {
       await this.tradeRepo.updateTradeStatus(trade.id, {
          last_exit_error: result.status === 'FAILED_ONCHAIN' ? `On-chain fail: ${JSON.stringify(result.err)}` : 'Unknown status',
          needs_attention: currentAttempts >= 3,
       });
       if (result.status === 'FAILED_ONCHAIN') throw new Error('Exit transaction failed on-chain');
       return; // Unknown status, we keep OPEN and wait for reconciliation
    }

    // SUCCESS flow
    const signature = result.signature;
    await new Promise((res) => setTimeout(res, 2000));
    const tx = await this.walletService.getParsedTransaction(signature);
    
    let solReceivedLamports = 0;
    let feeLamports = 0;
    let tokenSpentRaw = 0;

    if (tx && tx.meta) {
      feeLamports = tx.meta.fee || 0;
      const accountIndex = tx.transaction.message.accountKeys.findIndex((k: any) => k.pubkey.toBase58() === wallet.publicKey);
      if (accountIndex >= 0) {
        solReceivedLamports = tx.meta.postBalances[accountIndex] - tx.meta.preBalances[accountIndex] + feeLamports;
      }
      
      const preToken = tx.meta.preTokenBalances?.find((t: any) => t.owner === wallet.publicKey && t.mint === trade.token_mint);
      const postToken = tx.meta.postTokenBalances?.find((t: any) => t.owner === wallet.publicKey && t.mint === trade.token_mint);
      const preAmtRaw = preToken ? parseInt(preToken.uiTokenAmount.amount, 10) : 0;
      const postAmtRaw = postToken ? parseInt(postToken.uiTokenAmount.amount, 10) : 0;
      tokenSpentRaw = preAmtRaw - postAmtRaw;
    }

    const solReceived = solReceivedLamports > 0 ? solReceivedLamports / 1e9 : 0;
    
    // Remaining token balance on chain after tx
    const remainingTokenBalance = await this.walletService.getTokenBalance(wallet.publicKey, trade.token_mint);
    
    const newStatus = remainingTokenBalance <= 0 ? 'CLOSED' : 'PARTIAL_EXIT';
    const realizedPnlSol = (trade.realized_pnl_sol || 0) + solReceived - (trade.sol_amount * (percentageToClose / 100)); // Simplistic PNL 

    const pnlPercent = ((currentPriceUsd - trade.entry_price_usd) / trade.entry_price_usd) * 100;

    const updates: Partial<TradeRecord> = {
      status: newStatus,
      pnl_percent: pnlPercent,
      pnl_sol: realizedPnlSol,
      realized_pnl_sol: realizedPnlSol,
      tx_signature: signature,
      remaining_raw: remainingTokenBalance > 0 ? remainingTokenBalance : 0,
    };

    if (newStatus === 'CLOSED') {
      updates.closed_at = new Date().toISOString();
      updates.exit_price_usd = currentPriceUsd;
    }

    await this.tradeRepo.updateTradeStatus(trade.id, updates);
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
