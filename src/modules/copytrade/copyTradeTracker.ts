import { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import crypto from 'node:crypto';
import { logger } from '../../utils/logger';
import { currencyService } from '../../utils/currencyService';
import { CopyTradeRepository, CopyTradeTarget } from '../../database/repositories/copyTradeRepository';
import { StrategyReservationRepository } from '../../database/repositories/strategyReservationRepository';
import { TraderService } from '../trader/traderService';
import { ScannerService } from '../scanner/scannerService';
import { SecurityFilterService } from '../security/securityFilterService';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { UserStateService } from '../user/userStateService';
import { RiskManager } from '../autopilot/riskManager';
import { getRedisConnection } from '../../queue/connection';
import { escapeHtml } from '../telegram/formatters/messageFormatter';
import { appSettings } from '../../config/settings';
import { RuleEvaluator } from '../autopilot/ruleEvaluator';
import bs58 from 'bs58';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export function isValidSolanaSignature(signature: string): boolean {
  try {
    return bs58.decode(signature).length === 64;
  } catch {
    return false;
  }
}

type VerifiedTargetBuy = {
  tokenMint: string;
  nativeSpendLamports: bigint;
  wrappedSolSpendRaw: bigint;
};

function tokenBalancesByMint(
  balances: NonNullable<ParsedTransactionWithMeta['meta']>['postTokenBalances'],
  owner: string,
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const balance of balances ?? []) {
    if (balance.owner !== owner) continue;
    const current = totals.get(balance.mint) ?? 0n;
    totals.set(balance.mint, current + BigInt(balance.uiTokenAmount.amount));
  }
  return totals;
}

/**
 * Derive a copyable SOL buy only from value changes owned and authorized by the
 * watched wallet. A token transfer to the wallet is not proof that it bought it.
 */
export function extractVerifiedTargetBuy(
  transaction: ParsedTransactionWithMeta,
  walletAddress: string,
): VerifiedTargetBuy | null {
  if (!transaction.meta || transaction.meta.err) return null;

  const accountKeys = transaction.transaction.message.accountKeys;
  const targetIndex = accountKeys.findIndex((account) => account.pubkey.toBase58() === walletAddress);
  if (targetIndex < 0 || !accountKeys[targetIndex]?.signer) return null;

  const preLamports = transaction.meta.preBalances[targetIndex];
  const postLamports = transaction.meta.postBalances[targetIndex];
  if (!Number.isSafeInteger(preLamports) || !Number.isSafeInteger(postLamports)) return null;

  const paidFee = targetIndex === 0 ? transaction.meta.fee : 0;
  const nativeSpendLamports = BigInt(Math.max(0, preLamports - postLamports - paidFee));

  try {
    const preByMint = tokenBalancesByMint(transaction.meta.preTokenBalances, walletAddress);
    const postByMint = tokenBalancesByMint(transaction.meta.postTokenBalances, walletAddress);
    const allMints = new Set([...preByMint.keys(), ...postByMint.keys()]);
    const deltas = new Map<string, bigint>();
    for (const mint of allMints) {
      deltas.set(mint, (postByMint.get(mint) ?? 0n) - (preByMint.get(mint) ?? 0n));
    }

    const wrappedSolDelta = deltas.get(WSOL_MINT) ?? 0n;
    const wrappedSolSpendRaw = wrappedSolDelta < 0n ? -wrappedSolDelta : 0n;
    if (nativeSpendLamports <= 0n && wrappedSolSpendRaw <= 0n) return null;

    const boughtMints = [...deltas.entries()]
      .filter(([mint, delta]) => mint !== WSOL_MINT && delta > 0n)
      .map(([mint]) => mint);
    if (boughtMints.length !== 1) return null;

    return { tokenMint: boughtMints[0], nativeSpendLamports, wrappedSolSpendRaw };
  } catch {
    return null;
  }
}

export class CopyTradeTracker {
  private activeSubscriptions = new Map<string, number>();
  private activeTargets = new Set<string>();

  constructor(
    private readonly connection: Connection,
    private readonly copyTradeRepo: CopyTradeRepository,
    private readonly traderService: TraderService,
    private readonly scannerService: ScannerService,
    private readonly securityService: SecurityFilterService,
    private readonly autopilotRepo: AutopilotRepository,
    private readonly reservationRepo: StrategyReservationRepository,
    private readonly userStateService: UserStateService,
    private readonly botApi: any,
  ) {}

  async start(): Promise<void> {
    logger.info('Starting CopyTradeTracker...');
    setInterval(() => this.syncTargets(), 30_000);
    await this.syncTargets();
  }

  stop(): void {
    for (const subscriptionId of this.activeSubscriptions.values()) {
      this.connection.removeOnLogsListener(subscriptionId).catch(() => undefined);
    }
    this.activeSubscriptions.clear();
    this.activeTargets.clear();
  }

  private async syncTargets(): Promise<void> {
    try {
      const allActive = await this.copyTradeRepo.getAllActiveTargets();
      const newActiveSet = new Set<string>();
      const walletsToTrack = new Set<string>();
      for (const target of allActive) {
        newActiveSet.add(`${target.user_id}:${target.target_wallet_address}`);
        walletsToTrack.add(target.target_wallet_address);
      }
      this.activeTargets = newActiveSet;

      for (const [wallet, subscriptionId] of this.activeSubscriptions.entries()) {
        if (!walletsToTrack.has(wallet)) {
          await this.connection.removeOnLogsListener(subscriptionId);
          this.activeSubscriptions.delete(wallet);
        }
      }
      for (const wallet of walletsToTrack) {
        if (!this.activeSubscriptions.has(wallet)) this.subscribeToWallet(wallet);
      }
    } catch (error) {
      logger.error({ err: error }, 'Error syncing copy trade targets');
    }
  }

  private subscribeToWallet(walletAddress: string): void {
    try {
      const publicKey = new PublicKey(walletAddress);
      const subscriptionId = this.connection.onLogs(publicKey, async (logs) => {
        if (logs.err) return;
        const isSwap = logs.logs.some((line) => line.includes('Swap') || line.includes('Instruction: Swap') || line.includes('Route'));
        if (isSwap) await this.handlePotentialSwap(walletAddress, logs.signature);
      }, 'confirmed');
      this.activeSubscriptions.set(walletAddress, subscriptionId);
    } catch (error) {
      logger.error({ err: error, walletAddress }, 'Invalid copy-trade target wallet');
    }
  }

  private async handlePotentialSwap(walletAddress: string, signature: string): Promise<void> {
    if (!isValidSolanaSignature(signature)) {
      logger.warn({ walletAddress }, 'Copy trade skipped: invalid source transaction signature');
      return;
    }
    const redis = getRedisConnection();
    const dedupeKey = `copy_tx_processed:${walletAddress}:${signature}`;
    const claimed = await redis.set(dedupeKey, '1', 'EX', 7 * 24 * 60 * 60, 'NX');
    if (!claimed) return;

    try {
      const transaction = await this.waitForFinalizedSourceTransaction(signature);
      if (!transaction) {
        await redis.del(dedupeKey);
        logger.warn({ signature, walletAddress }, 'Copy trade skipped: source transaction did not finalize in time');
        return;
      }

      const verifiedBuy = extractVerifiedTargetBuy(transaction, walletAddress);
      if (!verifiedBuy) {
        logger.warn({ signature, walletAddress }, 'Copy trade skipped: source wallet did not authorize a verifiable SOL buy');
        return;
      }
      await this.executeCopies(walletAddress, verifiedBuy.tokenMint, signature);
    } catch (error) {
      await redis.del(dedupeKey).catch(() => undefined);
      logger.error({ err: error, signature }, 'Error proving finalized copy-trade source transaction');
    }
  }

  private async waitForFinalizedSourceTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
    const deadline = Date.now() + appSettings.COPY_SOURCE_FINALITY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const statuses = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = statuses.value[0];
      if (status?.err) return null;
      if (status?.confirmationStatus === 'finalized') {
        const transaction = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 1,
          commitment: 'finalized',
        });
        if (transaction) return transaction;
      }
      await new Promise((resolve) => setTimeout(resolve, appSettings.COPY_SOURCE_FINALITY_POLL_MS));
    }
    return null;
  }

  private async executeCopies(targetWallet: string, tokenMint: string, sourceSignature: string): Promise<void> {
    const followers = (await this.copyTradeRepo.getAllActiveTargets())
      .filter((target) => target.target_wallet_address === targetWallet);
    if (followers.length === 0) return;

    const pair = await this.scannerService.scanTokenByAddress(tokenMint);
    if (!pair) return;
    const priceUsd = Number(pair.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;

    const security = await this.securityService.evaluateToken(tokenMint, {
      liquidityUsd: pair.liquidity?.usd ?? null,
      marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
    });

    for (const follower of followers) {
      try {
        await this.executeFollower(follower, tokenMint, pair.baseToken.symbol, priceUsd, pair.liquidity?.usd ?? 0, security, sourceSignature);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ err: error, userId: follower.user_id, tokenMint }, 'Copy trade rejected');
        await this.botApi.sendMessage(
          follower.user_id,
          `⚠️ <b>Copy Trade Ditolak:</b> ${escapeHtml(message)}`,
          { parse_mode: 'HTML' },
        ).catch(() => undefined);
      }
    }
  }

  private async executeFollower(
    follower: CopyTradeTarget,
    tokenMint: string,
    tokenSymbol: string,
    priceUsd: number,
    liquidityUsd: number,
    security: Awaited<ReturnType<SecurityFilterService['evaluateToken']>>,
    sourceSignature: string,
  ): Promise<void> {
    const config = await this.autopilotRepo.getOrCreateConfig(follower.user_id);
    if (!config.is_active) throw new Error('autopilot is inactive for this follower');
    const safety = config.safety_params as Record<string, unknown>;
    const minimumScore = Number(safety.min_safety_score ?? appSettings.COPY_TRADE_PARAMS.DEFAULT_MIN_SAFETY_SCORE);
    const allowedLevels = Array.isArray(safety.allowed_levels) ? safety.allowed_levels.map(String) : ['SAFE'];
    const minimumLiquidity = Number(safety.min_liquidity_usd ?? appSettings.COPY_TRADE_PARAMS.DEFAULT_MIN_LIQUIDITY_USD);
    if (security.isHardBlocked) {
      throw new Error(`hard-block triggered: ${security.hardBlockReasons.join('; ')}`);
    }
    const criticalPolicy = RuleEvaluator.evaluateCriticalChecks(security, {
      minSafetyScore: minimumScore,
      allowedLevels,
      minLiquidityUsd: minimumLiquidity,
      maxTop10Percent: safety.max_top10_percent === undefined ? undefined : Number(safety.max_top10_percent),
      maxDeployerPercent: safety.max_deployer_percent === undefined ? undefined : Number(safety.max_deployer_percent),
      requireLpBurnOrLock: safety.lp_burn_or_lock_required === true,
    });
    if (criticalPolicy.failed.length > 0) {
      throw new Error(`critical security policy failed: ${criticalPolicy.failed.join('; ')}`);
    }
    if (security.score < minimumScore || !allowedLevels.includes(security.level) || liquidityUsd < minimumLiquidity) {
      throw new Error(`security gate failed (${security.score}/100, ${security.level}, liquidity $${liquidityUsd.toFixed(0)})`);
    }

    const state = await this.userStateService.getAutopilotState(follower.user_id);
    if (await this.userStateService.checkCircuitBreaker(follower.user_id, state)) {
      throw new Error(state.circuitBreakReason || 'circuit breaker active');
    }
    if (state.heldMints.includes(tokenMint)) throw new Error('token is already held or pending');

    await currencyService.fetchRates();
    const usdPerSol = currencyService.getUsdPerSol();
    if (!usdPerSol) throw new Error('fresh SOL/USD rate is unavailable');

    const sizing = config.sizing_params as Record<string, unknown>;
    const mode = String(sizing.mode ?? 'FIXED_SOL');
    const targetCapSol = follower.max_buy_usd / usdPerSol;
    let configuredSizeSol: number;
    if (mode === 'FIXED_SOL') {
      configuredSizeSol = Number(sizing.fixed_sol ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_FIXED_SOL);
    } else if (mode === 'PERCENT_BALANCE') {
      configuredSizeSol = state.availableBalanceSol * Number(sizing.percent_balance ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_PERCENT_BALANCE) / 100;
    } else {
      throw new Error('RISK_BASED copy sizing requires a verified stop-loss and is disabled');
    }
    const configuredCap = Number(sizing.max_size_per_trade ?? configuredSizeSol);
    const orderSol = Math.min(targetCapSol, configuredSizeSol, configuredCap);
    if (!Number.isFinite(orderSol) || orderSol <= 0) throw new Error('calculated copy size is invalid');

    const maxPositions = Number(sizing.max_concurrent_positions ?? appSettings.COPY_TRADE_PARAMS.DEFAULT_MAX_POSITIONS);
    const minReserveSol = Number(sizing.min_reserve_sol ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_MIN_RESERVE_SOL);
    const risk = RiskManager.canOpenNewPosition(
      { maxConcurrentPositions: maxPositions, minReserveSol },
      state.openPositionsCount,
      state.availableBalanceSol,
      orderSol,
    );
    if (!risk.allowed) throw new Error(risk.reason ?? 'risk limit rejected copy trade');

    const ownerToken = crypto.randomUUID();
    if (!await this.traderService.acquireBuyLock(follower.user_id, tokenMint, ownerToken, 30)) {
      throw new Error('another entry is already processing this token');
    }

    let reservationId: string | null = null;
    try {
      if (await this.traderService.hasActiveTrade(follower.user_id, tokenMint)) {
        throw new Error('token became active while acquiring entry lock');
      }
      const isDryRun = config.mode === 'PAPER';
      reservationId = await this.reservationRepo.reserve({
        userId: follower.user_id,
        tokenMint,
        strategy: 'COPY_TRADE',
        isDryRun,
        amountSol: orderSol,
        availableBalanceSol: state.availableBalanceSol,
        maxStrategyPositions: maxPositions,
        maxGlobalPositions: maxPositions,
        maxDailyBuys: appSettings.COPY_TRADE_PARAMS.MAX_DAILY_BUYS,
        maxDailyBudgetSol: targetCapSol * appSettings.COPY_TRADE_PARAMS.MAX_DAILY_BUYS,
      });
      if (!reservationId) throw new Error('atomic exposure, duplicate, or daily-budget gate rejected entry');

      await this.reservationRepo.finish(reservationId, 'IN_FLIGHT');
      const trade = await this.traderService.executeOrder({
        userId: follower.user_id,
        tokenMint,
        tokenSymbol,
        solAmount: orderSol,
        currentPriceUsd: priceUsd,
        isDryRun,
        source: 'AUTOPILOT',
        ownerToken,
        strategy: 'COPY_TRADE',
        copySourceSignature: sourceSignature,
        copyTargetWallet: follower.target_wallet_address,
        exitPolicy: { enabled: true, ...config.exit_params },
        strategyReservationId: reservationId,
      });
      if (trade.status === 'OPEN') await this.reservationRepo.finish(reservationId, 'COMPLETED');

      await this.botApi.sendMessage(
        follower.user_id,
        `⚡ <b>COPY TRADE ${trade.status === 'OPEN' ? 'TERKONFIRMASI' : 'TERKIRIM'}</b>\n\n` +
        `• <b>Token:</b> ${escapeHtml(tokenSymbol)} (<code>${tokenMint}</code>)\n` +
        `• <b>Alokasi:</b> ${orderSol.toFixed(6)} SOL\n` +
        `• <b>Sumber:</b> <code>${sourceSignature}</code>\n` +
        `• <b>Mode:</b> ${isDryRun ? 'PAPER' : 'LIVE'}`,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      if (reservationId) {
        const released = await this.reservationRepo.releaseIfUnbroadcast(reservationId);
        if (!released) throw new Error(`copy BUY outcome ambiguous; reservation ${reservationId} retained`);
      }
      throw error;
    } finally {
      await this.traderService.releaseBuyLock(follower.user_id, tokenMint, ownerToken);
    }
  }
}
