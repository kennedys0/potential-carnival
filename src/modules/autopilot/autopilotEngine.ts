import { AutopilotRepository, AutopilotConfigRecord } from '../../database/repositories/autopilotRepository';
import { SecurityScoreResult } from '../security/scoreCalculator';
import { AiAnalysis } from '../analyzer/analyzerService';
import { RuleEvaluator } from './ruleEvaluator';
import { CircuitBreaker, CircuitBreakerState } from './circuitBreaker';
import { RiskManager } from './riskManager';
import { TraderService } from '../trader/traderService';

export class AutopilotEngine {
  constructor(
    private readonly autopilotRepo: AutopilotRepository,
    private readonly traderService: TraderService
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
    }
  ): Promise<{ executed: boolean; reason: string }> {
    const config = await this.autopilotRepo.getOrCreateConfig(userId);

    if (!config.is_active) {
      return { executed: false, reason: 'Autopilot is inactive for user' };
    }

    // 1. Circuit Breaker Check
    const cbLimits = {
      maxDailyLossSol: (config.circuit_breaker_params.max_daily_loss_sol as number) || 1.0,
      maxConsecutiveLosses: (config.circuit_breaker_params.max_consecutive_losses as number) || 3,
    };
    const cbState: CircuitBreakerState = {
      dailyLossSol: currentState.dailyLossSol,
      consecutiveLosses: currentState.consecutiveLosses,
    };
    const cbCheck = CircuitBreaker.isBreached(cbLimits, cbState);
    if (cbCheck.isBreached) {
      return { executed: false, reason: `Circuit breaker active: ${cbCheck.reason}` };
    }

    // 2. Multi-stage Rule Evaluation
    const safetyParams = {
      minSafetyScore: (config.safety_params.min_safety_score as number) || 75,
      allowedLevels: (config.safety_params.allowed_levels as string[]) || ['SAFE'],
      minLiquidityUsd: (config.safety_params.min_liquidity_usd as number) || 10000,
    };
    const aiParams = {
      minConfidence: (config.ai_params.min_confidence as number) || 70,
      minRiskReward: (config.ai_params.min_risk_reward as number) || 1.5,
      allowedSetups: (config.ai_params.allowed_setups as string[]) || ['MOMENTUM', 'BREAKOUT'],
    };

    const evalResult = RuleEvaluator.evaluate(security, ai, safetyParams, aiParams, liquidityUsd);

    // Save audit log
    await this.autopilotRepo.saveDecisionLog({
      user_id: userId,
      token_mint: tokenMint,
      token_symbol: tokenSymbol,
      action: evalResult.action,
      safety_score: security.score,
      safety_flags: security.riskFlags,
      ai_verdict: ai?.verdict,
      ai_confidence: ai?.confidence,
      rules_passed: evalResult.rulesPassed,
      rules_failed: evalResult.rulesFailed,
      reason_summary: evalResult.reason,
    });

    if (!evalResult.passed) {
      return { executed: false, reason: evalResult.reason };
    }

    // 3. Risk Management & Position Sizing
    const orderSol = (config.sizing_params.fixed_sol as number) || 0.1;
    const riskCheck = RiskManager.canOpenNewPosition(
      {
        maxConcurrentPositions: (config.sizing_params.max_concurrent_positions as number) || 3,
        minReserveSol: (config.sizing_params.min_reserve_sol as number) || 0.05,
      },
      currentState.openPositionsCount,
      currentState.availableBalanceSol,
      orderSol
    );

    if (!riskCheck.allowed) {
      return { executed: false, reason: riskCheck.reason || 'Risk check failed' };
    }

    // 4. Execute Order (Paper or Live mode)
    const isDryRun = config.mode === 'PAPER';
    await this.traderService.executeOrder({
      userId,
      tokenMint,
      tokenSymbol,
      solAmount: orderSol,
      currentPriceUsd,
      isDryRun,
      source: 'AUTOPILOT',
    });

    return { executed: true, reason: `Order placed successfully in ${config.mode} mode` };
  }
}
