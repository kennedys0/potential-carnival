import { Connection } from '@solana/web3.js';
import { appSettings } from '../../config/settings';

export class FeeEstimator {
  constructor(private readonly connection: Connection) {}

  async getDynamicPriorityFee(): Promise<number> {
    try {
      const fees = await this.connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) return appSettings.PAPER_TRADE_FEE_LAMPORTS;
      const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      const index75 = Math.floor(sorted.length * 0.75);
      return sorted[index75] || appSettings.PAPER_TRADE_FEE_LAMPORTS;
    } catch {
      return appSettings.PAPER_TRADE_FEE_LAMPORTS; // default safe priority fee in micro-lamports
    }
  }
}
