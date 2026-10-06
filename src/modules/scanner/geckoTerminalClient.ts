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
}
