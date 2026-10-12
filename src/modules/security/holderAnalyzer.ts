import { Connection, PublicKey } from '@solana/web3.js';
import { FactorResult } from './scoreCalculator';

export interface HolderAnalysisOptions {
  pairAddress?: string | null;
  excludedAddresses?: (string | PublicKey)[];
}

export interface HolderDistributionResult {
  top10Percent: FactorResult<number>;
  largestHolderPercent: FactorResult<number>;
  totalHoldersSampled: number;
  excludedHoldersCount?: number;
  burnedPercent?: FactorResult<number>;
  poolPercent?: FactorResult<number>;
}

export const KNOWN_BURN_ADDRESSES = new Set([
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
  'dead111111111111111111111111111111111111111',
  '1111111111111111111111111111111111111111111',
]);

export const KNOWN_DEX_AND_VAULT_PROGRAMS = new Set([
  // Raydium AMM V4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  // Raydium CPMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'DNXgeM9EiiaAbaWzaQcu19vhhaxmA39m5utYrMNt443y',
  // Raydium CLMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  // Orca Whirlpools & Swap
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
  // Meteora DLMM, Dynamic & Pools
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi',
  // Pump.fun & Moonshot
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',
  // Phoenix & Lifinity
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
  // Token Lockers
  'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m',
]);

export class HolderAnalyzer {
  constructor(private readonly connection: Connection) {}

  async analyzeHolders(
    mintAddress: string,
    totalSupplyRaw: bigint,
    options?: HolderAnalysisOptions
  ): Promise<HolderDistributionResult> {
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
        .map((account) => ({
          account,
          addressStr: account.address
            ? (typeof account.address === 'string' ? account.address : account.address.toBase58?.() || String(account.address))
            : null,
          amountRaw: BigInt(account.amount),
        }))
        .filter(({ amountRaw }) => amountRaw > 0n)
        .sort((a, b) => (a.amountRaw === b.amountRaw ? 0 : a.amountRaw > b.amountRaw ? -1 : 1));

      const excludedSet = new Set<string>();
      if (options?.pairAddress) excludedSet.add(options.pairAddress);
      if (options?.excludedAddresses) {
        for (const addr of options.excludedAddresses) {
          const str = typeof addr === 'string' ? addr : addr.toBase58?.() || String(addr);
          excludedSet.add(str);
        }
      }

      // Attempt to inspect token accounts and their owners on-chain to identify pool vaults & burn addresses
      const accountMetaMap = await this.fetchAccountMetadata(validAccounts, excludedSet);

      let totalBurnedRaw = 0n;
      let totalPoolRaw = 0n;
      let excludedCount = 0;

      const regularAccounts: typeof validAccounts = [];

      for (let i = 0; i < validAccounts.length; i++) {
        const item = validAccounts[i];
        const addr = item.addressStr;
        const meta = accountMetaMap.get(i);
        const owner = meta?.owner;
        const ownerProgram = meta?.ownerProgram;
        const isExecutable = meta?.isExecutable;

        const isBurn =
          (addr ? KNOWN_BURN_ADDRESSES.has(addr) : false) ||
          (owner ? KNOWN_BURN_ADDRESSES.has(owner) : false);

        const isPoolOrVault =
          (addr ? KNOWN_DEX_AND_VAULT_PROGRAMS.has(addr) || excludedSet.has(addr) : false) ||
          (owner ? KNOWN_DEX_AND_VAULT_PROGRAMS.has(owner) || excludedSet.has(owner) : false) ||
          (ownerProgram ? KNOWN_DEX_AND_VAULT_PROGRAMS.has(ownerProgram) : false) ||
          isExecutable === true;

        if (isBurn) {
          totalBurnedRaw += item.amountRaw;
          excludedCount++;
        } else if (isPoolOrVault) {
          totalPoolRaw += item.amountRaw;
          excludedCount++;
        } else {
          regularAccounts.push(item);
        }
      }

      const effectiveSupplyRaw = totalSupplyRaw > totalBurnedRaw ? totalSupplyRaw - totalBurnedRaw : totalSupplyRaw;

      const topAccounts = regularAccounts.slice(0, 10);
      const top10AmountRaw = topAccounts.reduce((sum, holder) => sum + holder.amountRaw, 0n);
      if (top10AmountRaw > totalSupplyRaw) {
        throw new Error('Holder balances exceed token supply');
      }

      const top10Percent = this.rawPercent(top10AmountRaw, effectiveSupplyRaw);
      const largestHolderPercent = this.rawPercent(topAccounts[0]?.amountRaw ?? 0n, effectiveSupplyRaw);
      const burnedPercent = this.rawPercent(totalBurnedRaw, totalSupplyRaw);
      const poolPercent = this.rawPercent(totalPoolRaw, totalSupplyRaw);

      return {
        top10Percent: {
          value: top10Percent,
          status: 'OK',
          source: 'Solana RPC getTokenLargestAccounts (excluding pool/LP/burn)',
        },
        largestHolderPercent: {
          value: largestHolderPercent,
          status: 'OK',
          source: 'Solana RPC getTokenLargestAccounts (excluding pool/LP/burn)',
        },
        totalHoldersSampled: validAccounts.length,
        excludedHoldersCount: excludedCount,
        burnedPercent: {
          value: burnedPercent,
          status: 'OK',
          source: 'On-chain burn detection',
        },
        poolPercent: {
          value: poolPercent,
          status: 'OK',
          source: 'On-chain DEX pool detection',
        },
      };
    } catch (e: any) {
      return {
        top10Percent: {
          value: null,
          status: 'UNAVAILABLE',
          source: `Error: ${e.message}`,
        },
        largestHolderPercent: {
          value: null,
          status: 'UNAVAILABLE',
          source: `Error: ${e.message}`,
        },
        totalHoldersSampled: 0,
      };
    }
  }

  private async fetchAccountMetadata(
    accounts: Array<{ addressStr: string | null }>,
    excludedSet: Set<string>
  ): Promise<Map<number, { owner?: string; ownerProgram?: string; isExecutable?: boolean }>> {
    const metaMap = new Map<number, { owner?: string; ownerProgram?: string; isExecutable?: boolean }>();

    if (typeof this.connection.getMultipleAccountsInfo !== 'function') {
      return metaMap;
    }

    const pubkeysToFetch: PublicKey[] = [];
    const accountIndexMap: number[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const addrStr = accounts[i].addressStr;
      if (addrStr) {
        try {
          pubkeysToFetch.push(new PublicKey(addrStr));
          accountIndexMap.push(i);
        } catch {
          // Ignore invalid address strings
        }
      }
    }

    if (pubkeysToFetch.length === 0) return metaMap;

    try {
      const accountInfos = await this.connection.getMultipleAccountsInfo(pubkeysToFetch);
      if (!accountInfos) return metaMap;

      const ownerPubkeysToFetch: PublicKey[] = [];
      const ownerIndexMap: number[] = [];

      for (let j = 0; j < accountInfos.length; j++) {
        const info = accountInfos[j];
        const originalIdx = accountIndexMap[j];
        if (info && info.data && info.data.length >= 64) {
          const ownerPubkey = new PublicKey(info.data.subarray(32, 64));
          const ownerStr = ownerPubkey.toBase58();
          metaMap.set(originalIdx, { owner: ownerStr });

          if (
            !KNOWN_BURN_ADDRESSES.has(ownerStr) &&
            !KNOWN_DEX_AND_VAULT_PROGRAMS.has(ownerStr) &&
            !excludedSet.has(ownerStr)
          ) {
            ownerPubkeysToFetch.push(ownerPubkey);
            ownerIndexMap.push(originalIdx);
          }
        }
      }

      if (ownerPubkeysToFetch.length > 0) {
        try {
          const ownerAccountInfos = await this.connection.getMultipleAccountsInfo(ownerPubkeysToFetch);
          if (ownerAccountInfos) {
            for (let k = 0; k < ownerAccountInfos.length; k++) {
              const ownerInfo = ownerAccountInfos[k];
              const originalIdx = ownerIndexMap[k];
              if (ownerInfo) {
                const existing = metaMap.get(originalIdx) || {};
                const ownerProgram = ownerInfo.owner ? ownerInfo.owner.toBase58?.() || String(ownerInfo.owner) : undefined;
                existing.ownerProgram = ownerProgram;
                existing.isExecutable = ownerInfo.executable;
                metaMap.set(originalIdx, existing);
              }
            }
          }
        } catch {
          // Graceful degradation
        }
      }
    } catch {
      // Graceful degradation
    }

    return metaMap;
  }

  private rawPercent(amountRaw: bigint, supplyRaw: bigint): number {
    if (supplyRaw <= 0n) return 0;
    const precision = 1_000_000n;
    const scaledPercent = (amountRaw * 100n * precision + supplyRaw - 1n) / supplyRaw;
    return Number(scaledPercent) / Number(precision);
  }
}
