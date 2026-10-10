import { Connection, PublicKey } from '@solana/web3.js';
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
    const redis = getRedisConnection();
    const dedupeKey = `copy_tx_processed:${signature}`;
    const claimed = await redis.set(dedupeKey, '1', 'EX', 3600, 'NX');
    if (!claimed) return;

    setTimeout(async () => {
      try {
        const transaction = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 1,
          commitment: 'confirmed',
        });
        if (!transaction?.meta) return;

        const preBalances = transaction.meta.preTokenBalances ?? [];
        const boughtMints = (transaction.meta.postTokenBalances ?? [])
          .filter((post) => post.owner === walletAddress)
          .filter((post) => {
            const pre = preBalances.find((candidate) => candidate.accountIndex === post.accountIndex);
            return BigInt(post.uiTokenAmount.amount) > BigInt(pre?.uiTokenAmount.amount ?? '0');
          })
          .map((post) => post.mint)
          .filter((mint) => mint !== 'So11111111111111111111111111111111111111112');

        const uniqueBoughtMints = [...new Set(boughtMints)];
        if (uniqueBoughtMints.length !== 1) {
          logger.warn({ signature, walletAddress, boughtMints: uniqueBoughtMints }, 'Copy trade skipped: ambiguous bought asset set');
          return;
        }
        await this.executeCopies(walletAddress, uniqueBoughtMints[0], signature);
      } catch (error) {
        logger.error({ err: error, signature }, 'Error parsing copy-trade source transaction');
      }
    }, 2_000);
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
    const safety = config.safety_params as Record<string, unknown>;
    const minimumScore = Number(safety.min_safety_score ?? appSettings.COPY_TRADE_PARAMS.DEFAULT_MIN_SAFETY_SCORE);
    const allowedLevels = Array.isArray(safety.allowed_levels) ? safety.allowed_levels.map(String) : ['SAFE'];
    const minimumLiquidity = Number(safety.min_liquidity_usd ?? appSettings.COPY_TRADE_PARAMS.DEFAULT_MIN_LIQUIDITY_USD);
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
        exitPolicy: { enabled: true, ...config.exit_params },
      });
      await this.reservationRepo.finish(reservationId, trade.status === 'OPEN' ? 'COMPLETED' : 'IN_FLIGHT');

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
