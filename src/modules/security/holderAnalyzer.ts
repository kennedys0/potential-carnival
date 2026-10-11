import { Connection, PublicKey } from '@solana/web3.js';
import { FactorResult } from './scoreCalculator';

export interface HolderDistributionResult {
  top10Percent: FactorResult<number>;
  largestHolderPercent: FactorResult<number>;
  totalHoldersSampled: number;
}

export class HolderAnalyzer {
  constructor(private readonly connection: Connection) {}

  async analyzeHolders(mintAddress: string, totalSupplyRaw: bigint): Promise<HolderDistributionResult> {
    try {
      if (totalSupplyRaw <= 0n) throw new Error('Token supply must be positive');
      const mintPubkey = new PublicKey(mintAddress);
      const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);

      if (!largestAccounts || !largestAccounts.value || largestAccounts.value.length === 0) {
        throw new Error('No holder data found');
      }

      // Raw amounts remain exact even when RPC uiAmount is null or exceeds
      // JavaScript's safe-integer range.
      const validAccounts = largestAccounts.value
        .map((account) => ({ account, amountRaw: BigInt(account.amount) }))
        .filter(({ amountRaw }) => amountRaw > 0n)
        .sort((a, b) => (a.amountRaw === b.amountRaw ? 0 : a.amountRaw > b.amountRaw ? -1 : 1));
      const topAccounts = validAccounts.slice(0, 10);
      const top10AmountRaw = topAccounts.reduce((sum, holder) => sum + holder.amountRaw, 0n);
      if (top10AmountRaw > totalSupplyRaw) {
        throw new Error('Holder balances exceed token supply');
      }

      const top10Percent = this.rawPercent(top10AmountRaw, totalSupplyRaw);
      const largestHolderPercent = this.rawPercent(topAccounts[0]?.amountRaw ?? 0n, totalSupplyRaw);

      return {
        top10Percent: {
          value: top10Percent,
          status: 'OK',
          source: 'Solana RPC getTokenLargestAccounts'
        },
        largestHolderPercent: {
          value: largestHolderPercent,
          status: 'OK',
          source: 'Solana RPC getTokenLargestAccounts'
        },
        totalHoldersSampled: validAccounts.length,
      };
    } catch (e: any) {
      return {
        top10Percent: {
          value: null,
          status: 'UNAVAILABLE',
          source: `Error: ${e.message}`
        },
        largestHolderPercent: {
          value: null,
          status: 'UNAVAILABLE',
          source: `Error: ${e.message}`
        },
        totalHoldersSampled: 0,
      };
    }
  }

  private rawPercent(amountRaw: bigint, supplyRaw: bigint): number {
    const precision = 1_000_000n;
    const scaledPercent = (amountRaw * 100n * precision + supplyRaw - 1n) / supplyRaw;
    return Number(scaledPercent) / Number(precision);
  }
}
