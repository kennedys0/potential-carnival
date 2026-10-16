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
  take_profit_levels: [{ level: 1, price_usd: 1.2, percentage: 50 }],
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

describe('RuleEvaluator deterministic R:R authority (P0)', () => {
  const baseAiParams = { minConfidence: 70, minRiskReward: 1.5, allowedSetups: ['MOMENTUM'], requireAi: true };

  const rrAi: any = {
    verdict: 'BUY',
    confidence: 85,
    setup_type: 'MOMENTUM',
    stop_loss_usd: 90,
    // Actual RR = (108-100)/(100-90) = 0.8, tetapi LLM mengklaim 1.5
    risk_reward_ratio: 1.5,
    take_profit_levels: [{ level: 1, price_usd: 108, percentage: 50 }],
  };

  it('rejects inflated LLM-claimed R:R when deterministic R:R is below minimum', () => {
    const result = RuleEvaluator.evaluate(security, rrAi, safety, baseAiParams, 50_000, 100);
    expect(result.passed).toBe(false);
    expect(result.action).toBe('SKIP');
    expect(result.rulesFailed.some((r) => r.includes('Deterministic R:R 0.80 below minimum 1.5'))).toBe(true);
    expect(result.rulesFailed.some((r) => r.includes('LLM claimed 1.5'))).toBe(true);
  });

  it('accepts when deterministic R:R meets minimum even if LLM claimed differently', () => {
    const honest = {
      ...rrAi,
      risk_reward_ratio: 0.8, // klaim jujur tapi di bawah minimum juga tetap ditolak
      take_profit_levels: [{ level: 1, price_usd: 120, percentage: 50 }], // actual RR = 2.0
    };
    const result = RuleEvaluator.evaluate(security, honest, safety, baseAiParams, 50_000, 100);
    expect(result.passed).toBe(true);
    expect(result.rulesPassed.some((r) => r.includes('Deterministic R:R 2.00 >= 1.5'))).toBe(true);
  });

  it('fails closed when AI provides no usable TP levels', () => {
    const noTp = { ...rrAi, take_profit_levels: [] };
    const result = RuleEvaluator.evaluate(security, noTp, safety, baseAiParams, 50_000, 100);
    expect(result.passed).toBe(false);
    expect(result.rulesFailed).toContain('Cannot compute deterministic R:R from AI SL/TP levels');
  });

  it('fails closed when SL is at/above entry (no positive risk distance)', () => {
    const badSl = {
      ...rrAi,
      stop_loss_usd: 100,
      take_profit_levels: [{ level: 1, price_usd: 120, percentage: 50 }],
    };
    const result = RuleEvaluator.evaluate(security, badSl, safety, baseAiParams, 50_000, 100);
    expect(result.passed).toBe(false);
  });
});

describe('RuleEvaluator early-momentum fallback (no synthetic indicators)', () => {
  const fallbackParams = { minConfidence: 70, minRiskReward: 1.5, allowedSetups: [], requireAi: false };

  const earlyIndicators: any = {
    ema9: NaN,
    ema21: NaN,
    rsi14: NaN,
    atr14: NaN,
    vwap: NaN,
    volumeSpikeRatio: NaN,
    calculatedStopLoss: 0.9,
    calculatedTp1: NaN,
    calculatedTp2: NaN,
    isEarlyMomentum: true,
    earlyMomentum: {
      m5ChangePct: 12,
      buysM5: 8,
      sellsM5: 2,
      m5VolumeUsd: 5000,
      priceVsFirstOpenPct: 3,
    },
  };

  it('passes fallback on real early-momentum metrics, not fabricated EMA/RSI', () => {
    const result = RuleEvaluator.evaluate(security, null, safety, fallbackParams, 50_000, 1, earlyIndicators);
    expect(result.passed).toBe(true);
    expect(result.rulesPassed.some((r) => r.includes('Early momentum: aksi beli awal'))).toBe(true);
    // Tidak boleh ada klaim EMA/RSI palsu di log
    expect(result.rulesPassed.some((r) => r.includes('EMA9 > EMA21'))).toBe(false);
  });

  it('rejects when early-momentum metrics show no buying pressure', () => {
    const weak = {
      ...earlyIndicators,
      earlyMomentum: { m5ChangePct: -2, buysM5: 1, sellsM5: 5, m5VolumeUsd: 100, priceVsFirstOpenPct: -1 },
    };
    const result = RuleEvaluator.evaluate(security, null, safety, fallbackParams, 50_000, 1, weak);
    expect(result.passed).toBe(false);
    expect(result.rulesFailed).toContain('Early momentum criteria not met');
  });

  it('rejects NaN technical indicators that are NOT flagged as early momentum', () => {
    // Tanpa flag isEarlyMomentum, NaN harus ditolak eksplisit (tidak lolos vakum)
    const nanTech = { ...earlyIndicators, isEarlyMomentum: false, earlyMomentum: undefined };
    const result = RuleEvaluator.evaluate(security, null, safety, fallbackParams, 50_000, 1, nanTech);
    expect(result.passed).toBe(false);
    expect(result.rulesPassed.some((r) => r.includes('EMA9 > EMA21 (Bullish trend)'))).toBe(false);
  });
});
