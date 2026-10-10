import { TradeRepository, TradeRecord } from '../../database/repositories/tradeRepository';
import { appSettings } from '../../config/settings';
import { getEnv } from '../../config/env';
import { getRedisConnection } from '../../queue/connection';
import { LiveTradingDisabledError, KillSwitchActiveError } from '../../utils/errors';
import crypto from 'crypto';
import { FillParser } from './fillParser.js';
import { AccountingEngine } from './accountingEngine.js';
import { currencyService } from '../../utils/currencyService';
import { logger } from '../../utils/logger';

export interface OrderRequest {
  userId: number;
  tokenMint: string;
  tokenSymbol: string;
  solAmount: number;
  currentPriceUsd: number;
  isDryRun: boolean;
  source: 'MANUAL' | 'AUTOPILOT';
  slippageBps?: number;
  ownerToken?: string;
  strategy?: 'TRENDING' | 'NEW_TOKEN_SNIPER' | 'COPY_TRADE';
  exitPolicy?: Record<string, unknown>;
}

import { WalletService } from '../wallet/walletService';
import { JupiterClient, JupiterSwapBuildResult } from './jupiterClient';
import { PumpPortalClient } from './pumpPortalClient';
import { VersionedTransaction } from '@solana/web3.js';
import { SwapTransactionIntent } from '../wallet/transactionValidator.js';

export class TraderService {
  private readonly WSOL_MINT = 'So11111111111111111111111111111111111111112';

  constructor(
    private readonly tradeRepo: TradeRepository,
    private readonly walletService: WalletService,
    private readonly jupiterClient?: JupiterClient,
    private readonly pumpPortalClient: PumpPortalClient = new PumpPortalClient(),
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
      
      const tokenDecimals = 6; // Standard simulation decimals
      const tokenAmountRaw = Math.floor(tokenAmount * (10 ** tokenDecimals)).toString();
      const solSpentLamports = Math.floor(req.solAmount * 1e9);

      return this.tradeRepo.createTrade({
        user_id: req.userId,
        token_mint: req.tokenMint,
        token_symbol: req.tokenSymbol,
        side: 'BUY',
        source: req.source,
        is_dry_run: true,
        sol_amount: req.solAmount,
        token_amount: tokenAmount,
        token_amount_raw: tokenAmountRaw,
        remaining_raw: tokenAmountRaw,
        token_decimals: tokenDecimals,
        sol_spent_lamports: solSpentLamports,
        entry_price_usd: req.currentPriceUsd,
        fee_lamports: appSettings.PAPER_TRADE_FEE_LAMPORTS,
        status: 'OPEN',
        strategy: req.strategy || 'TRENDING',
        exit_policy_snapshot: req.exitPolicy ?? null,
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
    const slippageLimit = Math.min(req.slippageBps ?? appSettings.MAX_SLIPPAGE_BPS, appSettings.MAX_SLIPPAGE_BPS);
    if (!Number.isInteger(slippageLimit) || slippageLimit < 1) throw new Error('Invalid slippage limit');
    const slippageBps = Math.min(appSettings.DEFAULT_SLIPPAGE_BPS, slippageLimit);

    let transaction!: VersionedTransaction;
    let lastValidBlockHeight: number | undefined;
    let transactionIntent!: SwapTransactionIntent;

    let useJupiter = !req.tokenMint.endsWith('pump');

    if (!useJupiter) {
      try {
        const result = await this.pumpPortalClient.getSwapTransaction({
          publicKey: wallet.publicKey,
          action: 'buy',
          mint: req.tokenMint,
          amount: this.formatRawAmount(BigInt(amountLamports), 9),
          denominatedInSol: true,
          slippage: slippageLimit / 100,
          priorityFee: 0.0005,
          pool: 'pump'
        });
        transaction = result.transaction;
        transactionIntent = {
          provider: 'PUMP_PORTAL',
          side: 'BUY',
          walletPublicKey: wallet.publicKey,
          inputMint: this.WSOL_MINT,
          outputMint: req.tokenMint,
          inputAmountRaw: BigInt(amountLamports),
        };
      } catch (err: any) {
        logger.warn(`PumpPortal gagal untuk buy ${req.tokenMint}, fallback ke Jupiter. Error: ${err.message}`);
        useJupiter = true;
      }
    }

    if (useJupiter) {
      if (!this.jupiterClient) throw new Error('Jupiter client not initialized');
      const initialBuild = await this.jupiterClient.buildSwap(
        this.WSOL_MINT,
        req.tokenMint,
        BigInt(amountLamports),
        slippageBps,
        wallet.publicKey,
      );

      const priceImpactPct = Number(initialBuild.quote.priceImpactPct) * 100;
      if (priceImpactPct > appSettings.MAX_PRICE_IMPACT_PCT) {
        throw new Error(`Entry ditolak: Price impact (${priceImpactPct.toFixed(2)}%) melebihi batas (${appSettings.MAX_PRICE_IMPACT_PCT}%)`);
      }

      const dynamicSlippageBps = this.calculateDynamicSlippage(slippageBps, priceImpactPct, slippageLimit);
      
      const jupResult = dynamicSlippageBps === slippageBps
        ? initialBuild
        : await this.jupiterClient.buildSwap(
          this.WSOL_MINT,
          req.tokenMint,
          BigInt(amountLamports),
          dynamicSlippageBps,
          wallet.publicKey,
        );
      transaction = jupResult.transaction;
      lastValidBlockHeight = jupResult.lastValidBlockHeight;
      transactionIntent = this.jupiterIntent(jupResult, wallet.publicKey, 'BUY');
    }
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
        status: 'RESERVED',
        idempotency_key: idempotencyKey,
        blockhash,
        last_valid_block_height: lastValidBlockHeight,
        pending_since: new Date().toISOString(),
        strategy: req.strategy || 'TRENDING',
        exit_policy_snapshot: req.exitPolicy ?? null,
      });
    } catch (e: any) {
       // Probably idempotency collision
       throw new Error(`Failed to create PENDING trade (idempotency/duplicate?): ${e.message}`);
    }

    try {
      if (req.ownerToken) {
        const isValid = await this.tradeRepo.verifyBuyLock(req.userId, req.tokenMint, req.ownerToken);
        if (!isValid) {
          await this.tradeRepo.updateTradeStatus(tradeRecord.id!, { status: 'FAILED', failure_reason: 'BUY lock expired or stolen before broadcast. Fenced.' });
          throw new Error('BUY lock expired or stolen before broadcast. Fenced.');
        }
      }

      const result = await this.walletService.signAndSendVersionedTransaction(
        req.userId, 
        transaction,
        {
          intent: transactionIntent,
          onSignature: async (sig) => {
            tradeRecord.pending_signature = sig;
            if (tradeRecord.id) {
              await this.tradeRepo.updateTradeStatus(tradeRecord.id, { pending_signature: sig, status: 'SIGNED' });
            }
          },
          onSend: async () => {
            if (tradeRecord.id) {
              await this.tradeRepo.updateTradeStatus(tradeRecord.id, { status: 'BROADCAST_ATTEMPTED' });
            }
          }
        }
      );

      if (
        result.status === 'SIGN_FAILED' ||
        result.status === 'PERSISTENCE_FAILED' ||
        result.status === 'SUBMISSION_REJECTED' ||
        result.status === 'FAILED_ONCHAIN'
      ) {
        await this.tradeRepo.updateTradeStatus(tradeRecord.id!, {
          status: 'FAILED',
          failure_reason: `Failure: ${result.status} - ${JSON.stringify(result.err)}`,
        });
        throw new Error(`On-chain transaction failed: ${result.status}`);
      }

      if (
        result.status === 'UNKNOWN' ||
        result.status === 'SUBMISSION_TIMEOUT' ||
        result.status === 'CONFIRMING' ||
        result.status === 'EXPIRED'
      ) {
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
        fee_lamports: String(parseResult.feeLamports),
        tx_signature: signature,
        token_amount_raw: parseResult.tokenDeltaRaw.toString(),
        token_decimals: parseResult.decimals,
        sol_spent_lamports: parseResult.solDeltaLamports.toString(),
        remaining_raw: parseResult.tokenDeltaRaw.toString(),
      };

      await this.tradeRepo.atomicReconcileEntry(tradeRecord.id!, updates);
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

  async closePosition(trade: TradeRecord, currentPriceUsd: number, percentageToClose: number = 100): Promise<string> {
    if (!trade.id) throw new Error('Trade ID is missing');
    if (trade.status !== 'OPEN' && trade.status !== 'PARTIAL_EXIT') return 'SKIPPED';
    if (percentageToClose <= 0 || percentageToClose > 100) throw new Error('Invalid percentage');

    const pendingExits = await this.tradeRepo.getPendingExitAttempts(trade.id);
    if (pendingExits.length > 0) {
       throw new Error('Penutupan posisi sedang diproses (ada exit attempt pending).');
    }

    const redis = getRedisConnection();
    const lockKey = `lock:trade:close:${trade.id}`;
    const ownerToken = crypto.randomUUID();
    // Lock for 60 seconds to prevent double-sell with unique owner token
    const locked = await redis.set(lockKey, ownerToken, 'PX', 60000, 'NX');
    if (!locked) {
      throw new Error('Penutupan posisi sedang diproses (terkunci redis).');
    }

    try {

    const isPartial = percentageToClose < 100;

    if (trade.is_dry_run) {
      // Paper Trading close logic
      const tradeBalanceRaw = BigInt(trade.remaining_raw ?? trade.token_amount_raw ?? 0);
      const amountToCloseRaw = (tradeBalanceRaw * BigInt(Math.floor(percentageToClose * 100))) / 10000n;
      
      const priceMultiplier = trade.entry_price_usd > 0 ? (currentPriceUsd / trade.entry_price_usd) : 1;
      const initialSolSpent = trade.sol_amount ?? 0;
      if (trade.token_amount_raw === null || trade.token_amount_raw === undefined) {
        throw new Error('Paper trade is missing its initial token amount');
      }
      const initialTokenAmountRaw = BigInt(trade.token_amount_raw);
      
      let solCostBasisForThisExit = 0;
      if (initialTokenAmountRaw > 0n) {
          solCostBasisForThisExit = (initialSolSpent * Number(amountToCloseRaw)) / Number(initialTokenAmountRaw);
      }
      
      const solReceived = solCostBasisForThisExit * priceMultiplier;
      const solReceivedLamports = Math.floor(solReceived * 1e9);

      await this.tradeRepo.atomicReconcileExit(trade.id, undefined, {
        tx_signature: `PAPER_${Date.now()}`,
        exit_price_usd: currentPriceUsd,
        token_delta_raw: amountToCloseRaw.toString(),
        sol_delta_lamports: Number(solReceivedLamports),
        fee_lamports: 0,
      });
      return 'SUCCESS';
    }

    if (!this.jupiterClient) throw new Error('Jupiter client required for live trade execution');
    const wallet = await this.walletService.getOrCreateWallet(trade.user_id);
    
    // Total token balance on chain
    const totalTokenBalance = await this.walletService.getTokenBalance(wallet.publicKey, trade.token_mint);
    if (totalTokenBalance.raw === 0n) {
      await this.tradeRepo.updateTradeStatus(trade.id, {
        needs_attention: true,
      });
      throw new Error(`INVENTORY_DISCREPANCY: Wallet balance is 0 but trade has remaining_raw. Will not execute sell.`);
    }

    const tradeBalanceRaw = BigInt(trade.remaining_raw ?? 0);
    if (tradeBalanceRaw <= 0n) {
       throw new Error('Trade has no remaining raw tokens to close.');
    }

    const percentBps = BigInt(Math.floor(percentageToClose * 100)); // 100% = 10000 bps
    const calculatedAmount = (tradeBalanceRaw * percentBps) / 10000n;
    const amountLamportsBigInt = calculatedAmount < totalTokenBalance.raw ? calculatedAmount : totalTokenBalance.raw;

    if (amountLamportsBigInt <= 0n) {
      throw new Error('Calculated token amount to close is 0.');
    }
    
    // Increment exit attempts immediately
    const currentAttempts = (trade.exit_attempts ?? 0) + 1;
    await this.tradeRepo.updateTradeStatus(trade.id, { exit_attempts: currentAttempts });

    const baseSlippage = appSettings.EXIT_SLIPPAGE_BASE_BPS;
    const stepSlippage = appSettings.EXIT_SLIPPAGE_STEP_BPS;
    const maxSlippage = appSettings.EXIT_MAX_SLIPPAGE_BPS;
    const exitSlippageBps = Math.min(baseSlippage + (currentAttempts - 1) * stepSlippage, maxSlippage);

    let transaction!: VersionedTransaction;
    let lastValidBlockHeight: number | undefined;
    let transactionIntent!: SwapTransactionIntent;

    let useJupiter = !trade.token_mint.endsWith('pump');

    if (!useJupiter) {
      try {
        const result = await this.pumpPortalClient.getSwapTransaction({
          publicKey: wallet.publicKey,
          action: 'sell',
          mint: trade.token_mint,
          amount: this.formatRawAmount(amountLamportsBigInt, totalTokenBalance.decimals),
          denominatedInSol: false,
          slippage: exitSlippageBps / 100,
          priorityFee: 0.0005,
          pool: 'pump'
        });
        transaction = result.transaction;
        transactionIntent = {
          provider: 'PUMP_PORTAL',
          side: 'SELL',
          walletPublicKey: wallet.publicKey,
          inputMint: trade.token_mint,
          outputMint: this.WSOL_MINT,
          inputAmountRaw: amountLamportsBigInt,
        };
      } catch (err: any) {
        logger.warn(`PumpPortal gagal untuk sell ${trade.token_mint}, fallback ke Jupiter. Error: ${err.message}`);
        useJupiter = true;
      }
    }

    if (useJupiter) {
      if (!this.jupiterClient) throw new Error('Jupiter client not initialized');
      const jupResult = await this.jupiterClient.buildSwap(
        trade.token_mint,
        this.WSOL_MINT,
        amountLamportsBigInt,
        exitSlippageBps,
        wallet.publicKey,
      );
      transaction = jupResult.transaction;
      lastValidBlockHeight = jupResult.lastValidBlockHeight;
      transactionIntent = this.jupiterIntent(jupResult, wallet.publicKey, 'SELL');
    }
    
    const blockhash = transaction.message.recentBlockhash;
    
    // Create attempt record
    const attemptIdempotencyKey = `exit_${trade.id}_${currentAttempts}_${Date.now()}`;
    const exitAttempt = await this.tradeRepo.createExitAttempt({
      trade_id: trade.id,
      percentage: percentageToClose,
      tokens_amount_raw: amountLamportsBigInt.toString(),
      status: 'PENDING',
      idempotency_key: attemptIdempotencyKey
    });
    
    let result;
    let exitSignature: string | undefined;
    try {
      result = await this.walletService.signAndSendVersionedTransaction(
        trade.user_id, 
        transaction,
        {
          intent: transactionIntent,
          onSignature: async (sig) => {
            exitSignature = sig;
            if (exitAttempt.id) {
              await this.tradeRepo.updateExitAttempt(exitAttempt.id, { tx_signature: sig, status: 'SIGNED' });
            }
          },
          onSend: async () => {
            if (exitAttempt.id) {
              await this.tradeRepo.updateExitAttempt(exitAttempt.id, { status: 'BROADCAST_ATTEMPTED' });
            }
          }
        }
      );
    } catch (e: any) {
      const failureReason = e.message || 'Unknown execution error';
      // Only fail it if we are sure it didn't hit the network, otherwise keep PENDING
      if (!exitSignature) {
        await this.tradeRepo.updateTradeStatus(trade.id, {
          last_exit_error: failureReason,
          needs_attention: currentAttempts >= 3,
        });
        if (exitAttempt.id) {
          await this.tradeRepo.updateExitAttempt(exitAttempt.id, { status: 'FAILED' });
        }
      } else {
        logger.warn({ tradeId: trade.id, err: e }, 'Exception occurred after signing, leaving exit attempt as PENDING to prevent double-sell');
      }
      throw e;
    }

    if (
      result.status === 'SIGN_FAILED' ||
      result.status === 'PERSISTENCE_FAILED' ||
      result.status === 'SUBMISSION_REJECTED' ||
      result.status === 'FAILED_ONCHAIN'
    ) {
       await this.tradeRepo.updateTradeStatus(trade.id, {
          last_exit_error: `Exit failed: ${result.status} - ${JSON.stringify(result.err)}`,
          needs_attention: currentAttempts >= 3,
       });
       if (exitAttempt.id) {
         await this.tradeRepo.updateExitAttempt(exitAttempt.id, { status: 'FAILED' });
       }
       throw new Error(`Exit transaction failed: ${result.status}`);
    }

    if (
      result.status === 'UNKNOWN' ||
      result.status === 'SUBMISSION_TIMEOUT' ||
      result.status === 'CONFIRMING' ||
      result.status === 'EXPIRED'
    ) {
       await this.tradeRepo.updateTradeStatus(trade.id, {
          last_exit_error: `Uncertain status: ${result.status}`,
          needs_attention: currentAttempts >= 3,
       });
       // UNKNOWN status stays PENDING
       return 'UNCERTAIN';
    }

    // SUCCESS flow - DO NOT mark attempt SUCCESS until atomic reconciliation
    const signature = result.signature;
    await new Promise((res) => setTimeout(res, 2000));
    const tx = await this.walletService.getParsedTransaction(signature);
    
    let solReceivedLamports = "0";
    let feeLamports = "0";
    let tokenSpentRaw = "0";

    if (tx && tx.meta) {
      const parseResult = FillParser.parseSellFill(tx, wallet.publicKey, trade.token_mint);
      
      if (parseResult) {
         feeLamports = parseResult.feeLamports.toString();
         solReceivedLamports = parseResult.solDeltaLamports.toString();
         tokenSpentRaw = parseResult.tokenDeltaRaw.toString();
      }
    }

    if (!tx || !tx.meta || tokenSpentRaw === "0") {
      await this.tradeRepo.updateTradeStatus(trade.id, {
         tx_signature: signature,
         needs_attention: true,
         last_exit_error: 'TX_CONFIRMED - FILL_RECONCILIATION_REQUIRED',
      });
      // Do NOT update exitAttempt to SUCCESS yet because we haven't reconciled the accounting!
      return 'UNCERTAIN';
    }

    const acctResult = AccountingEngine.calculateExit({
      trade,
      actualTokensSpentRaw: BigInt(tokenSpentRaw),
      solReceivedLamports: solReceivedLamports,
      feeLamports: feeLamports,
      currentPriceUsd
    });

    const updates: Partial<TradeRecord> & { token_delta_raw?: string, sol_delta_lamports?: string | number, fee_lamports?: string | number } = {
      status: acctResult.newStatus,
      pnl_percent: acctResult.pnlPercent,
      pnl_sol: acctResult.pnlSol,
      realized_pnl_sol: acctResult.realizedPnlSol,
      tx_signature: signature,
      remaining_raw: acctResult.remainingRaw,
      token_delta_raw: tokenSpentRaw.toString(),
      sol_delta_lamports: solReceivedLamports,
      fee_lamports: feeLamports,
    };

    if (acctResult.newStatus === 'CLOSED') {
      updates.closed_at = new Date().toISOString();
      updates.exit_price_usd = currentPriceUsd;
    }

    // Removed edge case that falsely closed trades on zero balance
    if (exitAttempt.id) {
      await this.tradeRepo.atomicReconcileExit(trade.id, exitAttempt.id, updates);
    } else {
      await this.tradeRepo.updateTradeStatus(trade.id, updates);
    }

    } finally {
      // Atomic compare-and-delete to ensure we only release our own lock
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
      `;
      await redis.eval(luaScript, 1, lockKey, ownerToken).catch(err => {
        logger.error({ err, tradeId: trade.id }, 'Failed to release redis lock');
      });
    }

    return 'SUCCESS';
  }

  async acquireBuyLock(userId: number, tokenMint: string, ownerToken: string, ttlSeconds: number): Promise<boolean> {
    return this.tradeRepo.acquireBuyLock(userId, tokenMint, ownerToken, ttlSeconds);
  }

  async releaseBuyLock(userId: number, tokenMint: string, ownerToken: string): Promise<void> {
    await this.tradeRepo.releaseBuyLock(userId, tokenMint, ownerToken);
  }

  async hasActiveTrade(userId: number, tokenMint: string): Promise<boolean> {
    const activeTrades = await this.tradeRepo.getTradesByStatuses(
      userId,
      ['RESERVED', 'SIGNED', 'BROADCAST_ATTEMPTED', 'PENDING', 'OPEN', 'PARTIAL_EXIT'],
    );
    return activeTrades.some((trade) => trade.token_mint === tokenMint);
  }

  private jupiterIntent(
    build: JupiterSwapBuildResult,
    walletPublicKey: string,
    side: 'BUY' | 'SELL',
  ): SwapTransactionIntent {
    return {
      provider: 'JUPITER',
      side,
      walletPublicKey,
      inputMint: build.quote.inputMint,
      outputMint: build.quote.outputMint,
      inputAmountRaw: BigInt(build.quote.inAmount),
      minimumOutputAmountRaw: BigInt(build.quote.otherAmountThreshold),
      addressLookupTableAccounts: build.addressLookupTableAccounts,
    };
  }

  private formatRawAmount(amountRaw: bigint, decimals: number): string {
    if (!Number.isInteger(decimals) || decimals < 0) throw new Error('Invalid token decimals');
    if (decimals === 0) return amountRaw.toString();
    const digits = amountRaw.toString().padStart(decimals + 1, '0');
    const whole = digits.slice(0, -decimals);
    const fraction = digits.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  }

  private async assertTradingAllowed(userId: number, side: 'BUY' | 'SELL', isDryRun: boolean): Promise<void> {
    const redis = getRedisConnection();
    const isKillSwitchActive = await redis.get('killswitch:global');
    const isUserKillSwitchActive = await redis.get(`killswitch:user:${userId}`);
    
    // Kill-switch rejects BUY orders (entry), but allows SELL (exit)
    if ((isKillSwitchActive === '1' || isUserKillSwitchActive === '1') && side === 'BUY') {
      throw new KillSwitchActiveError();
    }
    
    // Live trading check for buys is already handled in the live path of executeOrder, 
    // but we can also enforce it here globally if it's not a dry run and we're entering
    if (!isDryRun && side === 'BUY' && !getEnv().LIVE_TRADING_ENABLED) {
        throw new LiveTradingDisabledError();
    }
  }
}
