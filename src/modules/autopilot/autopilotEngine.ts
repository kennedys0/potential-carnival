import { AutopilotRepository, AutopilotConfigRecord } from '../../database/repositories/autopilotRepository';
import { SecurityScoreResult } from '../security/scoreCalculator';
import { AiAnalysis } from '../analyzer/analyzerService';
import { RuleEvaluator } from './ruleEvaluator';
import { CircuitBreaker, CircuitBreakerState } from './circuitBreaker';
import { RiskManager } from './riskManager';
import { TraderService } from '../trader/traderService';
import { SniperRepository } from '../../database/repositories/sniperRepository';
import { StrategyReservationRepository } from '../../database/repositories/strategyReservationRepository';
import { sniperExitPolicy, failClosedSniperSafety, type ExitPolicySnapshot } from './strategyRisk';
import { getRedisConnection } from '../../queue/connection';
import { z } from 'zod';
import crypto from 'node:crypto';
import { appSettings } from '../../config/settings';

const SafetyParamsSchema = z.object({
  min_safety_score: z.number().default(75),
  allowed_levels: z.array(z.string()).default(['SAFE']),
  min_liquidity_usd: z.number().default(10000),
});

const AiParamsSchema = z.object({
  min_confidence: z.number().default(70),
  min_risk_reward: z.number().default(1.5),
  allowed_setups: z.array(z.string()).default(['MOMENTUM', 'BREAKOUT']),
});

const SizingParamsSchema = z.object({
  mode: z.enum(['FIXED_SOL', 'PERCENT_BALANCE', 'RISK_BASED']).default('FIXED_SOL'),
  fixed_sol: z.number().optional(),
  percent_balance: z.number().optional(),
  risk_percent: z.number().optional(),
  max_size_per_trade: z.number().optional(),
  max_concurrent_positions: z.number().default(3),
  min_reserve_sol: z.number().default(0.05),
});

const CircuitBreakerParamsSchema = z.object({
  max_daily_loss_sol: z.number().default(1.0),
  max_consecutive_losses: z.number().default(3),
});

export class AutopilotEngine {
  constructor(
    private readonly autopilotRepo: AutopilotRepository,
    private readonly traderService: TraderService,
    private readonly sniperRepo: SniperRepository,
    private readonly reservationRepo?: StrategyReservationRepository
  ) {}

  async processCandidate(
    userId: number,
    tokenMint: string,
    tokenSymbol: string,
    currentPriceUsd: number,
    liquidityUsd: number,
    security: SecurityScoreResult,
    ai: AiAnalysis | null,
    currentState: {
      openPositionsCount: number;
      availableBalanceSol: number;
      dailyLossSol: number;
      consecutiveLosses: number;
      heldMints?: string[];
    },
    rawSnapshot?: any,
    source: 'TRENDING' | 'SNIPER' = 'TRENDING'
  ): Promise<{ executed: boolean; reason: string; status?: 'COMPLETED' | 'PENDING' }> {
    let config: any;
    if (source === 'SNIPER') {
      config = await this.sniperRepo.getOrCreateConfig(userId);
      if (!config.enabled) {
        return { executed: false, reason: 'Sniper is disabled for user' };
      }
    } else {
      config = await this.autopilotRepo.getOrCreateConfig(userId);
      if (!config.is_active) {
        return { executed: false, reason: 'Autopilot is inactive for user' };
      }
    }

    if ((currentState as any).isCircuitBroken) {
      return { executed: false, reason: 'Global circuit breaker active' };
    }

    if (currentState.heldMints?.includes(tokenMint)) {
      await this.logDecision(userId, tokenMint, tokenSymbol, 'SKIP', security, ai, ['Token is already held'], [], 'Skipped because already held', rawSnapshot, source);
      return { executed: false, reason: 'Already holding this token' };
    }

    // Database Lock to prevent double buy
    const ownerToken = crypto.randomUUID();
    const acquired = await this.traderService['tradeRepo'].acquireBuyLock(userId, tokenMint, ownerToken, 30);
    if (!acquired) {
      return { executed: false, reason: 'Lock acquired by another process' };
    }

    try {
      // Re-verify after lock acquisition to prevent race condition from stale snapshot
      const activeTrades = await this.traderService['tradeRepo'].getTradesByStatuses(userId, ['RESERVED', 'SIGNED', 'BROADCAST_ATTEMPTED', 'PENDING', 'OPEN', 'PARTIAL_EXIT']);
      if (activeTrades.some((t: any) => t.token_mint === tokenMint)) {
        await this.logDecision(userId, tokenMint, tokenSymbol, 'SKIP', security, ai, ['Token is already held (Atomic check)'], [], 'Skipped because already held (atomic)', rawSnapshot, source);
        return { executed: false, reason: 'Already holding this token (atomic check)' };
      }

      return await this.evaluateAndExecute(userId, tokenMint, tokenSymbol, currentPriceUsd, liquidityUsd, security, ai, currentState, config, rawSnapshot, source, ownerToken);
    } finally {
      await this.traderService['tradeRepo'].releaseBuyLock(userId, tokenMint, ownerToken);
    }
  }

  private async evaluateAndExecute(
    userId: number,
    tokenMint: string,
    tokenSymbol: string,
    currentPriceUsd: number,
    liquidityUsd: number,
    security: SecurityScoreResult,
    ai: AiAnalysis | null,
    currentState: any,
    config: any,
    rawSnapshot: any,
    source: 'TRENDING' | 'SNIPER',
    ownerToken: string
  ): Promise<{ executed: boolean; reason: string; status?: 'COMPLETED' | 'PENDING' }> {
    // 1. Circuit Breaker Check
    const cbConfig = CircuitBreakerParamsSchema.parse(config.circuit_breaker_params || {});
    const cbLimits = {
      maxDailyLossSol: cbConfig.max_daily_loss_sol,
      maxConsecutiveLosses: cbConfig.max_consecutive_losses,
    };
    const cbState: CircuitBreakerState = {
      dailyLossSol: currentState.dailyLossSol,
      consecutiveLosses: currentState.consecutiveLosses,
    };
    const cbCheck = CircuitBreaker.isBreached(cbLimits, cbState);
    if (cbCheck.isBreached) {
      await this.logDecision(userId, tokenMint, tokenSymbol, 'REJECT', security, ai, [], ['Circuit Breaker'], `Circuit breaker active: ${cbCheck.reason}`, rawSnapshot, source);
      return { executed: false, reason: `Circuit breaker active: ${cbCheck.reason}` };
    }

    // 2. Multi-stage Rule Evaluation
    const safeConf = SafetyParamsSchema.parse(config.safety_params || {});
    const aiConf = AiParamsSchema.parse(config.ai_params || {});

    let safetyParams = {
      minSafetyScore: safeConf.min_safety_score,
      allowedLevels: safeConf.allowed_levels,
      minLiquidityUsd: safeConf.min_liquidity_usd,
    };
    let aiParams = {
      minConfidence: aiConf.min_confidence,
      minRiskReward: aiConf.min_risk_reward,
      allowedSetups: aiConf.allowed_setups,
      requireAi: true,
    };

    if (source === 'SNIPER') {
      // Sniper config parsing
      safetyParams = {
        minSafetyScore: config.minimum_safety_score ?? appSettings.SNIPER_PARAMS.MIN_SAFETY_SCORE,
        allowedLevels: appSettings.SNIPER_PARAMS.ALLOWED_LEVELS,
        minLiquidityUsd: config.min_liquidity_usd ?? appSettings.SNIPER_PARAMS.MIN_LIQUIDITY_USD,
      };
      aiParams.requireAi = appSettings.SNIPER_PARAMS.REQUIRE_AI;
    }

    if (source === 'SNIPER') {
      const securityVeto = failClosedSniperSafety(security, config.reject_unknown_critical_safety_checks);
      if (securityVeto) return { executed: false, reason: `Sniper security veto: ${securityVeto}` };
    }
    const evalResult = RuleEvaluator.evaluate(security, ai, safetyParams, aiParams, liquidityUsd, currentPriceUsd, rawSnapshot?.indicators);

    await this.logDecision(userId, tokenMint, tokenSymbol, evalResult.action, security, ai, evalResult.rulesPassed, evalResult.rulesFailed, evalResult.reason, rawSnapshot, source);

    if (!evalResult.passed) {
      return { executed: false, reason: evalResult.reason };
    }

    if (source === 'SNIPER' && config.require_sell_route &&
        security.report?.find((r: any) => r.name === 'Sell Simulation')?.value !== 'Success') {
      return { executed: false, reason: 'Sell route not verified' };
    }

    // 3. Risk Management & Position Sizing
    const sizingConf = SizingParamsSchema.parse(config.sizing_params || {});
    let orderSol = 0;
    
    if (source === 'SNIPER') {
       orderSol = config.buy_amount_sol ?? 0.01;
       sizingConf.max_concurrent_positions = config.max_active_positions ?? 3;
    } else {
      if (sizingConf.mode === 'FIXED_SOL') {
        orderSol = sizingConf.fixed_sol ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_FIXED_SOL;
      } else if (sizingConf.mode === 'PERCENT_BALANCE') {
        orderSol = (currentState.availableBalanceSol * (sizingConf.percent_balance ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_PERCENT_BALANCE)) / 100;
      } else if (sizingConf.mode === 'RISK_BASED') {
        if (ai && ai.stop_loss_usd > 0 && currentPriceUsd > ai.stop_loss_usd) {
          const slDistance = (currentPriceUsd - ai.stop_loss_usd) / currentPriceUsd;
          orderSol = ((currentState.availableBalanceSol * (sizingConf.risk_percent ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_RISK_PERCENT)) / 100) / slDistance;
        } else {
          return { executed: false, reason: 'Risk based sizing failed: invalid SL' };
        }
      }
      if (sizingConf.max_size_per_trade && orderSol > sizingConf.max_size_per_trade) {
        orderSol = sizingConf.max_size_per_trade;
      }
    }

    // Strategy limits are separate; global wallet exposure remains shared.
    const strategyCount = source === 'SNIPER'
      ? (currentState.sniperPositionsCount ?? currentState.openPositionsCount)
      : (currentState.trendingPositionsCount ?? currentState.openPositionsCount);
    const riskCheck = RiskManager.canOpenNewPosition(
      {
        maxConcurrentPositions: sizingConf.max_concurrent_positions,
        minReserveSol: sizingConf.min_reserve_sol,
      },
      strategyCount,
      currentState.availableBalanceSol,
      orderSol
    );

    if (!riskCheck.allowed) {
      return { executed: false, reason: riskCheck.reason || 'Risk check failed' };
    }

    // 4. Atomically reserve shared capital and positions for BOTH strategies.
    // A missing 029 migration or failed RPC MUST reject the entry, never bypass limits.
    if (!this.reservationRepo) {
      return { executed: false, reason: 'Strategy reservation service unavailable' };
    }
    const isDryRun = source === 'SNIPER' ? (config.trading_mode === 'PAPER') : (config.mode === 'PAPER');
    const trendingConfig = source === 'SNIPER' ? await this.autopilotRepo.getOrCreateConfig(userId) : config;
    const sniperConfig = source === 'SNIPER' ? config : await this.sniperRepo.getOrCreateConfig(userId);
    const trendingMax = Number((trendingConfig.sizing_params as any)?.max_concurrent_positions ?? appSettings.STRATEGY_RESERVATION_PARAMS.DEFAULT_TRENDING_MAX_POSITIONS);
    const sniperMax = Number(sniperConfig.max_active_positions ?? appSettings.STRATEGY_RESERVATION_PARAMS.DEFAULT_SNIPER_MAX_POSITIONS);
    const globalMax = trendingMax + sniperMax;
    const strategy = source === 'SNIPER' ? 'NEW_TOKEN_SNIPER' : 'TRENDING';
    const reservationId = await this.reservationRepo.reserve({
      userId, tokenMint, strategy, isDryRun, amountSol: orderSol,
      availableBalanceSol: currentState.availableBalanceSol,
      maxStrategyPositions: sizingConf.max_concurrent_positions,
      maxGlobalPositions: globalMax,
      maxDailyBuys: source === 'SNIPER' ? config.max_buys_per_day : undefined,
      maxDailyBudgetSol: source === 'SNIPER' ? config.max_daily_entry_budget_sol : undefined,
    });
    if (!reservationId) {
      return { executed: false, reason: 'Atomic exposure/daily budget/duplicate check rejected the entry' };
    }

    const exitPolicy: ExitPolicySnapshot | Record<string,unknown> = source === 'SNIPER'
      ? sniperExitPolicy(config)
      : { enabled: true, ...((config.exit_params as any) ?? {}) };

    try {
      const trade = await this.traderService.executeOrder({
        userId, tokenMint, tokenSymbol, solAmount: orderSol, currentPriceUsd,
        isDryRun, source: 'AUTOPILOT', ownerToken,
        strategy, exitPolicy,
        slippageBps: source === 'SNIPER' ? config.max_slippage_bps : undefined,
      });
      const completed = trade.status === 'OPEN';
      // An ambiguous broadcast is NOT a completed BUY; hold reservation for reconciliation.
      await this.reservationRepo.finish(reservationId, completed ? 'COMPLETED' : 'IN_FLIGHT');
      return {
        executed: true,
        status: completed ? 'COMPLETED' : 'PENDING',
        reason: completed
          ? `${strategy} BUY confirmed and accounted in ${isDryRun ? 'PAPER' : 'LIVE'} mode`
          : `${strategy} BUY submitted; awaiting transaction reconciliation`,
      };
    } catch (error) {
      // SQL only permits release when no active BUY exists. A crash after broadcast
      // conservatively retains the reservation rather than risking a second BUY.
      const released = await this.reservationRepo.releaseIfUnbroadcast(reservationId);
      if (!released) {
        throw new Error(`BUY outcome ambiguous; reservation ${reservationId} retained. Original error: ${String(error)}`);
      }
      throw error;
    }
  }

  private async logDecision(
    userId: number,
    tokenMint: string,
    tokenSymbol: string,
    action: 'BUY' | 'SKIP' | 'REJECT',
    security: SecurityScoreResult,
    ai: AiAnalysis | null,
    rulesPassed: string[],
    rulesFailed: string[],
    reason: string,
    rawSnapshot: any,
    strategy: 'TRENDING' | 'SNIPER' = 'TRENDING'
  ) {
    const fullSnapshot = {
      ...rawSnapshot,
      security,
      ai,
    };
    
    await this.autopilotRepo.saveDecisionLog({
      user_id: userId,
      token_mint: tokenMint,
      token_symbol: tokenSymbol,
      action,
      safety_score: security.score,
      safety_flags: security.riskFlags,
      ai_verdict: ai?.verdict,
      ai_confidence: ai?.confidence,
      rules_passed: rulesPassed,
      rules_failed: rulesFailed,
      reason_summary: reason,
      raw_snapshot: fullSnapshot,
      strategy: strategy === 'SNIPER' ? 'NEW_TOKEN_SNIPER' : 'TRENDING',
    });
  }
}

