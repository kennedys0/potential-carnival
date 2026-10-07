import { TradeRepository, TradeRecord } from '../../database/repositories/tradeRepository';
import { appSettings } from '../../config/settings';
import { getEnv } from '../../config/env';
import { getRedisConnection } from '../../queue/connection';
import { LiveTradingDisabledError, KillSwitchActiveError } from '../../utils/errors';
import crypto from 'crypto';
import { FillParser } from './fillParser.js';
import { currencyService } from '../../utils/currencyService';

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
      // Paper Trading: kurs SOL/USD HARUS nyata. Tanpa data segar -> tolak (bukan memakai angka palsu).
      await currencyService.fetchRates();
      const usdPerSol = currencyService.getUsdPerSol();
      if (usdPerSol === null) {
        throw new Error('Kurs SOL/USD tidak tersedia; trade paper ditolak (bot tidak memakai harga palsu). Coba lagi sebentar lagi.');
      }
      const tokenAmount = req.currentPriceUsd > 0 ? (req.solAmount * usdPerSol) / req.currentPriceUsd : 0;
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

    const initialQuote = await this.jupiterClient.getQuote(
      this.WSOL_MINT,
      req.tokenMint,
      amountLamports,
      slippageBps
    );

    const priceImpactPct = Number(initialQuote.priceImpactPct ?? 0) * 100;
    if (priceImpactPct > appSettings.MAX_PRICE_IMPACT_PCT) {
      throw new Error(`Entry ditolak: Price impact (${priceImpactPct.toFixed(2)}%) melebihi batas (${appSettings.MAX_PRICE_IMPACT_PCT}%)`);
    }

    const dynamicSlippageBps = this.calculateDynamicSlippage(slippageBps, priceImpactPct, appSettings.MAX_SLIPPAGE_BPS);
    
    // Re-fetch quote with dynamic slippage
    const quote = await this.jupiterClient.getQuote(
      this.WSOL_MINT,
      req.tokenMint,
      amountLamports,
      dynamicSlippageBps
    );

    const { transaction, lastValidBlockHeight } = await this.jupiterClient.getSwapTransaction(quote, wallet.publicKey);
    const blockhash = transaction.message.recentBlockhash;

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
        blockhash,
        last_valid_block_height: lastValidBlockHeight,
        pending_since: new Date().toISOString(),
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
          // Tandai di memori SEBELUM apa pun yang bisa melempar: setelah signature ada, tx mungkin sudah terkirim,
          // jadi blok catch di bawah TIDAK boleh menandai trade FAILED.
          tradeRecord.pending_signature = sig;
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
      // Wait, "retry + backoff (jumlah/jeda dari config, bukan delay tetap)"
      const maxRetries = appSettings.CONFIRMATION_RETRIES;
      const retryDelay = appSettings.CONFIRMATION_DELAY_MS;
      
      let tx = null;
      for (let i = 0; i < maxRetries; i++) {
        await new Promise((res) => setTimeout(res, retryDelay));
        tx = await this.walletService.getParsedTransaction(signature);
        if (tx) break;
      }

      if (!tx || !tx.meta) {
        // If we can't parse it yet, leave it to reconciliation to fix remaining_raw and token_amount
        return tradeRecord;
      }

      const parseResult = FillParser.parseBuyFill(tx, wallet.publicKey, req.tokenMint);
      
      if (!parseResult) {
         return tradeRecord; // Stay PENDING if cannot parse > 0 tokens
      }

      const finalSolAmount = Number(parseResult.solDeltaLamports) / 1e9;
      const finalTokenAmount = Number(parseResult.tokenDeltaRaw) / Math.pow(10, parseResult.decimals);

      const updates: Partial<TradeRecord> = {
        status: 'OPEN',
        sol_amount: finalSolAmount,
        token_amount: finalTokenAmount,
        fee_lamports: Number(parseResult.feeLamports),
        tx_signature: signature,
        token_amount_raw: Number(parseResult.tokenDeltaRaw),
        token_decimals: parseResult.decimals,
        sol_spent_lamports: Number(parseResult.solDeltaLamports),
        remaining_raw: Number(parseResult.tokenDeltaRaw),
      };

      await this.tradeRepo.updateTradeStatus(tradeRecord.id!, updates);
      return { ...tradeRecord, ...updates };

    } catch (err: any) {
      const failureReason = err.message || 'Unknown execution error';
      // Only fail it if we are sure it didn't hit the network, otherwise keep PENDING
      // If signAndSendVersionedTransaction throws before sending, it's safe to FAILED.
      if (!tradeRecord.pending_signature || tradeRecord.pending_signature === 'SIGN_FAILED') {
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

    const redis = getRedisConnection();
    const lockKey = `lock:trade:close:${trade.id}`;
    // Lock for 15 seconds to prevent double-sell across webhook, API, and monitor
    const locked = await redis.set(lockKey, 'locked', 'PX', 15000, 'NX');
    if (!locked) {
      throw new Error('Penutupan posisi sedang diproses (terkunci).');
    }

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
    if (totalTokenBalance.raw === 0n) {
      // If we are supposed to have tokens but balance is 0, mark closed
      await this.tradeRepo.updateTradeStatus(trade.id, {
        status: 'CLOSED',
        closed_at: new Date().toISOString(),
        needs_attention: true, // Needs attention because tokens disappeared unexpectedly
      });
      return;
    }

    const tradeBalanceRaw = trade.remaining_raw ?? 0;
    if (tradeBalanceRaw <= 0) {
       throw new Error('Trade has no remaining raw tokens to close.');
    }

    const calculatedAmount = Math.floor(tradeBalanceRaw * (percentageToClose / 100));
    const amountLamports = Math.min(calculatedAmount, Number(totalTokenBalance.raw));

    if (amountLamports <= 0) {
      throw new Error('Calculated token amount to close is 0.');
    }

    // Increment exit attempts immediately
    const currentAttempts = (trade.exit_attempts ?? 0) + 1;
    await this.tradeRepo.updateTradeStatus(trade.id, { exit_attempts: currentAttempts });

    const baseSlippage = appSettings.EXIT_SLIPPAGE_BASE_BPS;
    const stepSlippage = appSettings.EXIT_SLIPPAGE_STEP_BPS;
    const maxSlippage = appSettings.EXIT_MAX_SLIPPAGE_BPS;
    const exitSlippageBps = Math.min(baseSlippage + (currentAttempts - 1) * stepSlippage, maxSlippage);

    const quote = await this.jupiterClient.getQuote(
      trade.token_mint,
      this.WSOL_MINT,
      amountLamports,
      exitSlippageBps
    );

    const { transaction, lastValidBlockHeight } = await this.jupiterClient.getSwapTransaction(quote, wallet.publicKey);
    const blockhash = transaction.message.recentBlockhash;
    
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
      const parseResult = FillParser.parseSellFill(tx, wallet.publicKey, trade.token_mint);
      
      if (parseResult) {
         feeLamports = Number(parseResult.feeLamports);
         solReceivedLamports = Number(parseResult.solDeltaLamports);
         tokenSpentRaw = Number(parseResult.tokenDeltaRaw);
      }
    }

    const solReceived = solReceivedLamports > 0 ? solReceivedLamports / 1e9 : 0;
    
    // Fallback if tokenSpentRaw is 0 (failed to parse), use amountLamports
    const actualTokensSpent = tokenSpentRaw > 0 ? tokenSpentRaw : amountLamports;
    const newTradeRemainingRaw = Math.max(0, tradeBalanceRaw - actualTokensSpent);
    
    const newStatus = newTradeRemainingRaw <= 0 ? 'CLOSED' : 'PARTIAL_EXIT';
    
    // PnL Calculation based on proportional cost
    let realizedPnlSol = trade.realized_pnl_sol ?? 0;
    let pnlPercent = trade.pnl_percent ?? 0;
    
    if (trade.sol_spent_lamports && trade.token_amount_raw && trade.token_amount_raw > 0) {
      const solSpentLamportsBigInt = BigInt(trade.sol_spent_lamports);
      const actualTokensSpentBigInt = BigInt(actualTokensSpent);
      const tokenAmountRawBigInt = BigInt(trade.token_amount_raw);
      
      const costLamports = (solSpentLamportsBigInt * actualTokensSpentBigInt) / tokenAmountRawBigInt;
      const costSol = Number(costLamports) / 1e9;
      const feeSol = feeLamports / 1e9;
      
      const currentRealized = solReceived - costSol - feeSol;
      realizedPnlSol += currentRealized;
      
      if (costSol > 0) {
        pnlPercent = ((solReceived - costSol) / costSol) * 100;
      }
    }

    const updates: Partial<TradeRecord> = {
      status: newStatus,
      pnl_percent: pnlPercent,
      pnl_sol: realizedPnlSol,
      realized_pnl_sol: realizedPnlSol,
      tx_signature: signature,
      remaining_raw: newTradeRemainingRaw,
    };

    if (newStatus === 'CLOSED') {
      updates.closed_at = new Date().toISOString();
      updates.exit_price_usd = currentPriceUsd;
    }

    // Edge case: if wallet is completely empty, ensure we close
    const totalRemainingTokenBalance = await this.walletService.getTokenBalance(wallet.publicKey, trade.token_mint);
    if (totalRemainingTokenBalance.raw === 0n && newStatus !== 'CLOSED') {
      updates.status = 'CLOSED';
      updates.remaining_raw = 0;
      updates.closed_at = new Date().toISOString();
      updates.exit_price_usd = currentPriceUsd;
      updates.needs_attention = true;
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
