import { Connection } from '@solana/web3.js';

export class FeeEstimator {
  constructor(private readonly connection: Connection) {}

  async getDynamicPriorityFee(): Promise<number> {
    try {
      const fees = await this.connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) return 50000;
      const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      const index75 = Math.floor(sorted.length * 0.75);
      return sorted[index75] || 50000;
    } catch {
      return 50000; // default safe priority fee in micro-lamports
    }
  }
}
