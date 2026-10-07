import { describe, it, expect } from 'vitest';
import { ScoreCalculator, SecurityEvaluationInput } from '../../src/modules/security/scoreCalculator';

describe('ScoreCalculator', () => {
  it('triggers hard-block when mint authority is active', () => {
    const input: SecurityEvaluationInput = {
      mintAuthorityActive: { value: true, status: 'OK', source: 'test' },
      freezeAuthorityActive: { value: false, status: 'OK', source: 'test' },
      dangerousExtensions: { value: [], status: 'OK', source: 'test' },
      lpBurnedOrLocked: { value: true, status: 'OK', source: 'test' },
      top10HolderPercent: { value: 12, status: 'OK', source: 'test' },
      deployerHoldingPercent: { value: 2, status: 'OK', source: 'test' },
      liquidityUsd: { value: 50000, status: 'OK', source: 'test' },
      marketCapUsd: { value: 200000, status: 'OK', source: 'test' },
      sellSimulationSuccess: { value: true, status: 'OK', source: 'test' },
      effectiveTaxPercent: { value: 0, status: 'OK', source: 'test' },
      deployerRugCount: { value: 0, status: 'OK', source: 'test' },
    };

    const result = ScoreCalculator.calculate(input);
    expect(result.score).toBe(0);
    expect(result.level).toBe('UNAVAILABLE');
    expect(result.isHardBlocked).toBe(true);
    expect(result.hardBlockReasons).toContain('Mint authority still active');
  });

  it('calculates SAFE score for ideal token', () => {
    const input: SecurityEvaluationInput = {
      mintAuthorityActive: { value: false, status: 'OK', source: 'test' },
      freezeAuthorityActive: { value: false, status: 'OK', source: 'test' },
      dangerousExtensions: { value: [], status: 'OK', source: 'test' },
      lpBurnedOrLocked: { value: true, status: 'OK', source: 'test' },
      top10HolderPercent: { value: 14, status: 'OK', source: 'test' },
      deployerHoldingPercent: { value: 1.5, status: 'OK', source: 'test' },
      liquidityUsd: { value: 80000, status: 'OK', source: 'test' },
      marketCapUsd: { value: 350000, status: 'OK', source: 'test' },
      sellSimulationSuccess: { value: true, status: 'OK', source: 'test' },
      effectiveTaxPercent: { value: 0.5, status: 'OK', source: 'test' },
      deployerRugCount: { value: 0, status: 'OK', source: 'test' },
    };

    const result = ScoreCalculator.calculate(input);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.level).toBe('SAFE');
    expect(result.isHardBlocked).toBe(false);
  });

  it('regression: token with only 2 passing factors and rest unavailable is not SAFE', () => {
    // If only mint & freeze authority are checked and everything else is UNAVAILABLE,
    // coverage should be very low (e.g. 2 / 10 = 20%), so overall score max is 20, making it DANGER or WARNING, never SAFE.
    const input: SecurityEvaluationInput = {
      mintAuthorityActive: { value: false, status: 'OK', source: 'test' },
      freezeAuthorityActive: { value: false, status: 'OK', source: 'test' },
      dangerousExtensions: { value: null, status: 'UNAVAILABLE', source: 'test' },
      lpBurnedOrLocked: { value: null, status: 'UNAVAILABLE', source: 'test' },
      top10HolderPercent: { value: null, status: 'UNAVAILABLE', source: 'test' },
      deployerHoldingPercent: { value: null, status: 'UNAVAILABLE', source: 'test' },
      liquidityUsd: { value: null, status: 'UNAVAILABLE', source: 'test' },
      marketCapUsd: { value: null, status: 'UNAVAILABLE', source: 'test' },
      sellSimulationSuccess: { value: null, status: 'UNAVAILABLE', source: 'test' },
      effectiveTaxPercent: { value: null, status: 'UNAVAILABLE', source: 'test' },
      deployerRugCount: { value: null, status: 'UNAVAILABLE', source: 'test' },
    };

    const result = ScoreCalculator.calculate(input);
    expect(result.level).not.toBe('SAFE');
    // Usually missing critical things like sellSimulation or liquidity triggers a hard block too
    expect(result.score).toBeLessThan(50);
  });
});
