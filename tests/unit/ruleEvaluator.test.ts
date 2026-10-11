import { describe, expect, it } from 'vitest';
import { RuleEvaluator } from '../../src/modules/autopilot/ruleEvaluator';

const security: any = {
  score: 95,
  level: 'SAFE',
  isHardBlocked: false,
  hardBlockReasons: [],
  criticalChecks: {},
};

const safety = {
  minSafetyScore: 75,
  allowedLevels: ['SAFE'],
  minLiquidityUsd: 10_000,
};

const ai: any = {
  verdict: 'BUY',
  confidence: 90,
  risk_reward_ratio: 2,
  stop_loss_usd: 0.9,
  setup_type: 'REVERSAL',
};

describe('RuleEvaluator allowed setup boundary', () => {
  it('rejects an otherwise valid AI BUY when its setup is not allowed', () => {
    const result = RuleEvaluator.evaluate(
      security,
      ai,
      safety,
      { minConfidence: 70, minRiskReward: 1.5, allowedSetups: ['BREAKOUT'], requireAi: true },
      50_000,
      1,
    );

    expect(result.passed).toBe(false);
    expect(result.rulesFailed).toContain('AI setup REVERSAL not in allowed setup list');
  });

  it('normalizes configured setup names but fails closed for an empty allowlist', () => {
    const allowed = RuleEvaluator.evaluate(
      security,
      { ...ai, setup_type: 'BREAKOUT' },
      safety,
      { minConfidence: 70, minRiskReward: 1.5, allowedSetups: [' breakout '], requireAi: true },
      50_000,
      1,
    );
    expect(allowed.passed).toBe(true);

    const empty = RuleEvaluator.evaluate(
      security,
      { ...ai, setup_type: 'BREAKOUT' },
      safety,
      { minConfidence: 70, minRiskReward: 1.5, allowedSetups: [], requireAi: true },
      50_000,
      1,
    );
    expect(empty.passed).toBe(false);
  });
});
