export interface CircuitBreakerLimits {
  maxDailyLossSol: number;
  maxConsecutiveLosses: number;
}

export interface CircuitBreakerState {
  dailyLossSol: number;
  consecutiveLosses: number;
}

export class CircuitBreaker {
  static isBreached(
    limits: CircuitBreakerLimits,
    state: CircuitBreakerState
  ): { isBreached: boolean; reason?: string } {
    if (state.dailyLossSol >= limits.maxDailyLossSol) {
      return {
        isBreached: true,
        reason: `Daily loss limit exceeded: ${state.dailyLossSol} SOL (Max: ${limits.maxDailyLossSol} SOL)`,
      };
    }

    if (state.consecutiveLosses >= limits.maxConsecutiveLosses) {
      return {
        isBreached: true,
        reason: `Max consecutive losses reached: ${state.consecutiveLosses} trades`,
      };
    }

    return { isBreached: false };
  }
}
