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
    liquidityUsd: number
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
        rulesPassed.push('AI skipped (not required)');
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
