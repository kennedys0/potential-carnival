import type { Candle } from '../analyzer/indicators/atr';
import type { NewPoolCandidate } from './sniperPoolSelection';
const MARKET_DATA_FETCH_TIMEOUT_MS = 8_000;

export class GeckoTerminalClient {
  private readonly baseUrl = 'https://api.geckoterminal.com/api/v2';

  async getOHLCV(
    network: string,
    poolAddress: string,
    timeframe: 'minute' | 'hour' | 'day' = 'minute',
    aggregate: number = 5, // e.g. 5 minutes
    limit: number = 50
  ): Promise<Candle[]> {
    try {
      const url = `${this.baseUrl}/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(MARKET_DATA_FETCH_TIMEOUT_MS),
      });
      
      if (!res.ok) return [];

      const data: any = await res.json();
      if (!data.data || !data.data.attributes || !data.data.attributes.ohlcv_list) {
        return [];
      }

      // GeckoTerminal returns array of [timestamp, open, high, low, close, volume]
      const ohlcvList: number[][] = data.data.attributes.ohlcv_list;
      
      // GeckoTerminal returns newest first, so we reverse it to oldest first for EMA calculations
      return ohlcvList.map(row => ({
        timestamp: row[0] * 1000, // convert to ms
        open: row[1],
        high: row[2],
        low: row[3],
        close: row[4],
        volume: row[5],
      })).reverse();
    } catch {
      return [];
    }
  }

  async getNewPools(network: string = 'solana', page: number = 1): Promise<NewPoolCandidate[]> {
    try {
      const url = `${this.baseUrl}/networks/${network}/new_pools?page=${page}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json;version=20230302' },
        signal: AbortSignal.timeout(MARKET_DATA_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      
      const data: any = await res.json();
      const pools: any[] = data?.data ?? [];
      const included: any[] = data?.included ?? [];
      
      const result: NewPoolCandidate[] = [];
      for (const pool of pools) {
        const poolAddr = pool.attributes?.address;
        const relBaseToken = pool.relationships?.base_token?.data;
        if (!poolAddr || !relBaseToken) continue;
        const baseToken = included.find((i: any) => i.type === relBaseToken.type && i.id === relBaseToken.id);
        const tokenAddress = baseToken?.attributes?.address ?? relBaseToken.id?.split('_')[1];
        // The quoted price belongs to the base asset. Do not snipe SOL/USDC
        // as if it were the newly paired quote mint; reversed pools need a
        // separate, explicitly validated quote-token normalization pipeline.
        const settlementMints = new Set([
          'So11111111111111111111111111111111111111112',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          'Es9vMFrzaCERzQuc2hNvZWtSz18fLo9vTjrq1xYGYz1',
        ]);
        if (settlementMints.has(tokenAddress)) continue;
        const symbol = baseToken?.attributes?.symbol ?? '???';
        const rawCreatedAt = pool.attributes?.pool_created_at;
        const poolCreatedAtMs = typeof rawCreatedAt === 'string'
          ? Date.parse(rawCreatedAt) : null;
        if (!tokenAddress || !Number.isFinite(poolCreatedAtMs)) continue;
        result.push({ tokenAddress, pairAddress: poolAddr, symbol, poolCreatedAtMs });
      }
      return result;
    } catch {
      return [];
    }
  }
}
