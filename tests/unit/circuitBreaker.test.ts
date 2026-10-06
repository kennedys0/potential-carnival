import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../src/modules/autopilot/circuitBreaker';

describe('CircuitBreaker', () => {
  it('triggers pause when daily loss limit is breached', () => {
    const limits = { maxDailyLossSol: 1.0, maxConsecutiveLosses: 3 };
    const state = { dailyLossSol: 1.2, consecutiveLosses: 1 };

    const triggered = CircuitBreaker.isBreached(limits, state);
    expect(triggered.isBreached).toBe(true);
    expect(triggered.reason).toContain('Daily loss limit exceeded');
  });

  it('triggers pause when consecutive losses limit is reached', () => {
    const limits = { maxDailyLossSol: 2.0, maxConsecutiveLosses: 3 };
    const state = { dailyLossSol: 0.5, consecutiveLosses: 3 };

    const triggered = CircuitBreaker.isBreached(limits, state);
    expect(triggered.isBreached).toBe(true);
    expect(triggered.reason).toContain('Max consecutive losses reached');
  });

  it('does not trigger when metrics are within safe boundaries', () => {
    const limits = { maxDailyLossSol: 2.0, maxConsecutiveLosses: 3 };
    const state = { dailyLossSol: 0.2, consecutiveLosses: 1 };

    const triggered = CircuitBreaker.isBreached(limits, state);
    expect(triggered.isBreached).toBe(false);
  });
});
