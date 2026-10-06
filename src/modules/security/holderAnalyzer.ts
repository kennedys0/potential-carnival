import { Connection, PublicKey } from '@solana/web3.js';
import { FactorResult } from './scoreCalculator';

export interface HolderDistributionResult {
  top10Percent: FactorResult<number>;
  largestHolderPercent: FactorResult<number>;
  totalHoldersSampled: number;
}

export class HolderAnalyzer {
  constructor(private readonly connection: Connection) {}

  async analyzeHolders(mintAddress: string, totalSupply: number): Promise<HolderDistributionResult> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);

      if (!largestAccounts || !largestAccounts.value || largestAccounts.value.length === 0) {
        throw new Error('No holder data found');
      }

      // Filter out typical zero/burn or known addresses if needed
      // TODO: Proper resolve owner and EXCLUDE pool/LP/vault/burn/program-owned
      const validAccounts = largestAccounts.value.filter(acc => acc.uiAmount && acc.uiAmount > 0);
      const topAccounts = validAccounts.slice(0, 10);
      const top10Amount = topAccounts.reduce((acc, curr) => acc + (curr.uiAmount || 0), 0);

      const top10Percent = totalSupply > 0 ? (top10Amount / totalSupply) * 100 : 0;
      const largestHolderPercent =
        totalSupply > 0 && topAccounts[0]?.uiAmount
          ? (topAccounts[0].uiAmount / totalSupply) * 100
          : 0;

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
}
