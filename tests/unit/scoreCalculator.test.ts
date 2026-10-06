import { describe, it, expect } from 'vitest';
import { ScoreCalculator, SecurityEvaluationInput } from '../../src/modules/security/scoreCalculator';

describe('ScoreCalculator', () => {
  it('triggers hard-block when mint authority is active', () => {
    const input: SecurityEvaluationInput = {
      mintAuthorityActive: true,
      freezeAuthorityActive: false,
      dangerousExtensions: [],
      lpBurnedOrLocked: true,
      top10HolderPercent: 12,
      deployerHoldingPercent: 2,
      liquidityUsd: 50000,
      marketCapUsd: 200000,
      sellSimulationSuccess: true,
      effectiveTaxPercent: 0,
      deployerRugCount: 0,
    };

    const result = ScoreCalculator.calculate(input);
    expect(result.score).toBe(0);
    expect(result.level).toBe('DANGER');
    expect(result.isHardBlocked).toBe(true);
    expect(result.hardBlockReasons).toContain('Mint authority still active');
  });

  it('calculates SAFE score for ideal token', () => {
    const input: SecurityEvaluationInput = {
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      dangerousExtensions: [],
      lpBurnedOrLocked: true,
      top10HolderPercent: 14,
      deployerHoldingPercent: 1.5,
      liquidityUsd: 80000,
      marketCapUsd: 350000,
      sellSimulationSuccess: true,
      effectiveTaxPercent: 0.5,
      deployerRugCount: 0,
    };

    const result = ScoreCalculator.calculate(input);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.level).toBe('SAFE');
    expect(result.isHardBlocked).toBe(false);
  });
});
