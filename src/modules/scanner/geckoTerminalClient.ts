import { Candle } from '../analyzer/indicators/atr';

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
      const res = await fetch(url);
      
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

  async getNewPools(network: string = 'solana', page: number = 1): Promise<{ tokenAddress: string; pairAddress: string; symbol: string }[]> {
    try {
      const url = `${this.baseUrl}/networks/${network}/new_pools?page=${page}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json;version=20230302' } });
      if (!res.ok) return [];
      
      const data: any = await res.json();
      const pools: any[] = data?.data ?? [];
      const included: any[] = data?.included ?? [];
      
      const result: { tokenAddress: string; pairAddress: string; symbol: string }[] = [];
      for (const pool of pools) {
        const poolAddr = pool.attributes?.address;
        const relBaseToken = pool.relationships?.base_token?.data;
        if (!poolAddr || !relBaseToken) continue;
        const baseToken = included.find((i: any) => i.type === relBaseToken.type && i.id === relBaseToken.id);
        const tokenAddress = baseToken?.attributes?.address ?? relBaseToken.id?.split('_')[1];
        const symbol = baseToken?.attributes?.symbol ?? '???';
        if (!tokenAddress) continue;
        result.push({ tokenAddress, pairAddress: poolAddr, symbol });
      }
      return result;
    } catch {
      return [];
    }
  }
}
