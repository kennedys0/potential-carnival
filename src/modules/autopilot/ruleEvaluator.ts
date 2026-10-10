import { SecurityScoreResult } from '../security/scoreCalculator';
import { AiAnalysis } from '../analyzer/analyzerService';

export interface AutopilotSafetyFilterParams {
  minSafetyScore: number;
  allowedLevels: string[];
  minLiquidityUsd: number;
}

export interface AutopilotAiCriteriaParams {
  minConfidence: number;
  minRiskReward: number;
  allowedSetups: string[];
  requireAi?: boolean;
}

export class RuleEvaluator {
  static evaluate(
    security: SecurityScoreResult,
    ai: AiAnalysis | null,
    safetyParams: AutopilotSafetyFilterParams,
    aiParams: AutopilotAiCriteriaParams,
    liquidityUsd: number,
    currentPriceUsd: number,
    indicators?: any
  ): {
    passed: boolean;
    action: 'BUY' | 'SKIP' | 'REJECT';
    reason: string;
    rulesPassed: string[];
    rulesFailed: string[];
  } {
    const rulesPassed: string[] = [];
    const rulesFailed: string[] = [];

    // 1. HARD BLOCKS ALWAYS REJECT
    if (security.isHardBlocked) {
      rulesFailed.push(...security.hardBlockReasons);
      return {
        passed: false,
        action: 'REJECT',
        reason: `Hard-block triggered: ${security.hardBlockReasons.join('; ')}`,
        rulesPassed,
        rulesFailed,
      };
    }

    // 2. Safety Score Threshold
    if (security.score < safetyParams.minSafetyScore) {
      rulesFailed.push(`Safety score ${security.score} below minimum ${safetyParams.minSafetyScore}`);
    } else {
      rulesPassed.push(`Safety score ${security.score} >= ${safetyParams.minSafetyScore}`);
    }

    // 3. Level Check
    if (!safetyParams.allowedLevels.includes(security.level)) {
      rulesFailed.push(`Safety level ${security.level} not in allowed list`);
    } else {
      rulesPassed.push(`Safety level ${security.level} allowed`);
    }

    // 4. Min Liquidity
    if (liquidityUsd < safetyParams.minLiquidityUsd) {
      rulesFailed.push(`Liquidity $${liquidityUsd} below minimum $${safetyParams.minLiquidityUsd}`);
    } else {
      rulesPassed.push(`Liquidity $${liquidityUsd} >= $${safetyParams.minLiquidityUsd}`);
    }

    // 5. AI Verdict & Criteria
    if (!ai) {
      if (aiParams.requireAi !== false) {
        rulesFailed.push('AI analysis unavailable');
      } else {
        // Fallback mode: Use technical indicators instead of blindly passing
        if (indicators) {
           let fallbackPassed = true;
           if (indicators.ema9 <= indicators.ema21) {
              rulesFailed.push(`Fallback: EMA9 (${indicators.ema9.toFixed(4)}) <= EMA21 (${indicators.ema21.toFixed(4)})`);
              fallbackPassed = false;
           } else {
              rulesPassed.push('Fallback: EMA9 > EMA21 (Bullish trend)');
           }
           if (indicators.rsi14 >= 70 || indicators.rsi14 <= 30) {
              rulesFailed.push(`Fallback: RSI14 (${indicators.rsi14.toFixed(2)}) out of safe zone (30-70)`);
              fallbackPassed = false;
           } else {
              rulesPassed.push('Fallback: RSI14 is safe');
           }
           if (indicators.volumeSpikeRatio < 1.5) {
              rulesFailed.push(`Fallback: Volume Spike (${indicators.volumeSpikeRatio.toFixed(1)}x) < 1.5x`);
              fallbackPassed = false;
           } else {
              rulesPassed.push('Fallback: Volume Spike >= 1.5x');
           }
           
           if (!fallbackPassed) {
              rulesFailed.push('Fallback indicators criteria not met');
           }
        } else {
           rulesFailed.push('AI unavailable and technical indicators are unavailable');
        }
      }
    } else {
      if (ai.verdict !== 'BUY') {
        const aiReasons = ai.key_reasons && ai.key_reasons.length > 0 ? ` karena ${ai.key_reasons.join(', ')}` : '';
        rulesFailed.push(`AI verdict was ${ai.verdict}${aiReasons}`);
      } else {
        rulesPassed.push('AI verdict BUY');
      }

      if (ai.confidence < aiParams.minConfidence) {
        rulesFailed.push(`AI confidence ${ai.confidence}% below minimum ${aiParams.minConfidence}%`);
      } else {
        rulesPassed.push(`AI confidence ${ai.confidence}% >= ${aiParams.minConfidence}%`);
      }

      if (ai.risk_reward_ratio < aiParams.minRiskReward) {
        rulesFailed.push(`AI R:R ${ai.risk_reward_ratio} below minimum ${aiParams.minRiskReward}`);
      } else {
        rulesPassed.push(`AI R:R ${ai.risk_reward_ratio} >= ${aiParams.minRiskReward}`);
      }
      
      // Deterministic validation of AI-generated financial parameters
      if (ai.stop_loss_usd > 0 && currentPriceUsd > 0) {
        const slDistancePct = ((currentPriceUsd - ai.stop_loss_usd) / currentPriceUsd) * 100;
        if (slDistancePct < 2) {
            rulesFailed.push(`AI Stop Loss too tight: ${slDistancePct.toFixed(2)}% (min 2%)`);
        } else if (slDistancePct > 50) {
            rulesFailed.push(`AI Stop Loss too wide: ${slDistancePct.toFixed(2)}% (max 50%)`);
        } else {
            rulesPassed.push(`AI Stop Loss distance valid: ${slDistancePct.toFixed(2)}%`);
        }
      }
    }

    if (rulesFailed.length > 0) {
      return {
        passed: false,
        action: 'SKIP',
        reason: rulesFailed.join('; '),
        rulesPassed,
        rulesFailed,
      };
    }

    return {
      passed: true,
      action: 'BUY',
      reason: 'All safety and AI criteria passed',
      rulesPassed,
      rulesFailed: [],
    };
  }
}
