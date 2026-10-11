const MARKET_DATA_FETCH_TIMEOUT_MS = 8_000;

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

  /** Fetch the specific discovered liquidity pool; never pick the most liquid pool for a sniper. */
  async getPairByAddress(pairAddress: string): Promise<DexScreenerPair | null> {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`, {
        signal: AbortSignal.timeout(MARKET_DATA_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const payload: any = await res.json();
      const pair = (payload.pairs ?? []).find((p: any) => p.chainId === 'solana' && p.pairAddress === pairAddress);
      return pair ?? null;
    } catch {
      return null;
    }
  }

  async getTokenData(tokenAddress: string): Promise<DexScreenerPair | null> {
    try {
      const res = await fetch(`${this.baseUrl}/${tokenAddress}`, {
        signal: AbortSignal.timeout(MARKET_DATA_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      if (!data.pairs || data.pairs.length === 0) return null;
      // Filter pairs for solana chain and sort by liquidity descending
      const solanaPairs = data.pairs
        .filter((p: any) =>
          p.chainId === 'solana'
          && p.baseToken?.address === tokenAddress
          && Number.isFinite(Number(p.priceUsd))
          && Number(p.priceUsd) > 0
        )
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      return solanaPairs[0] || null;
    } catch {
      return null;
    }
  }
}
