import { Connection, PublicKey } from '@solana/web3.js';

export interface HolderDistributionResult {
  top10Percent: number;
  largestHolderPercent: number;
  totalHoldersSampled: number;
}

export class HolderAnalyzer {
  constructor(private readonly connection: Connection) {}

  async analyzeHolders(mintAddress: string, totalSupply: number): Promise<HolderDistributionResult> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);

      if (!largestAccounts || !largestAccounts.value || largestAccounts.value.length === 0) {
        return { top10Percent: 100, largestHolderPercent: 100, totalHoldersSampled: 0 };
      }

      // Filter out typical zero/burn or known addresses if needed
      const topAccounts = largestAccounts.value.slice(0, 10);
      const top10Amount = topAccounts.reduce((acc, curr) => acc + (curr.uiAmount || 0), 0);

      const top10Percent = totalSupply > 0 ? (top10Amount / totalSupply) * 100 : 100;
      const largestHolderPercent =
        totalSupply > 0 && topAccounts[0]?.uiAmount
          ? (topAccounts[0].uiAmount / totalSupply) * 100
          : 100;

      return {
        top10Percent,
        largestHolderPercent,
        totalHoldersSampled: largestAccounts.value.length,
      };
    } catch {
      return { top10Percent: 100, largestHolderPercent: 100, totalHoldersSampled: 0 };
    }
  }
}
