export interface RiskLimits {
  maxConcurrentPositions: number;
  minReserveSol: number;
}

export class RiskManager {
  static canOpenNewPosition(
    limits: RiskLimits,
    currentPositionsCount: number,
    availableBalanceSol: number,
    orderSolAmount: number
  ): { allowed: boolean; reason?: string } {
    if (currentPositionsCount >= limits.maxConcurrentPositions) {
      return {
        allowed: false,
        reason: `Max concurrent positions limit reached (${currentPositionsCount}/${limits.maxConcurrentPositions})`,
      };
    }

    const balanceAfterOrder = availableBalanceSol - orderSolAmount;
    if (balanceAfterOrder < limits.minReserveSol) {
      return {
        allowed: false,
        reason: `Insufficient balance: must keep at least ${limits.minReserveSol} SOL reserved for fees and rent`,
      };
    }

    return { allowed: true };
  }
}
