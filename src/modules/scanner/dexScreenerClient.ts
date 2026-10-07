export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
  volume: { m5: number; h1: number; h24: number };
  priceChange: { m5: number; h1: number; h24: number };
  pairCreatedAt: number;
  fdv?: number;
  marketCap?: number;
}

export class DexScreenerClient {
  private readonly baseUrl = 'https://api.dexscreener.com/latest/dex/tokens';

  async getTokenData(tokenAddress: string): Promise<DexScreenerPair | null> {
    try {
      const res = await fetch(`${this.baseUrl}/${tokenAddress}`);
      if (!res.ok) return null;
      const data: any = await res.json();
      if (!data.pairs || data.pairs.length === 0) return null;
      // Filter pairs for solana chain and sort by liquidity descending
      const solanaPairs = data.pairs
        .filter((p: any) => p.chainId === 'solana')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      return solanaPairs[0] || null;
    } catch {
      return null;
    }
  }
}
