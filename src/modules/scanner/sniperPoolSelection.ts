import type { DexScreenerPair } from './dexScreenerClient';
export interface NewPoolCandidate {
  tokenAddress: string;
  pairAddress: string;
  symbol: string;
  poolCreatedAtMs: number | null;
}
export function matchDiscoveredPool(pool: NewPoolCandidate, pair: DexScreenerPair | null): DexScreenerPair | null {
  if (!pair || pair.chainId !== 'solana' || pair.pairAddress !== pool.pairAddress
    || pair.baseToken.address !== pool.tokenAddress) return null;
  return pair;
}
