import { DexScreenerClient, DexScreenerPair } from './dexScreenerClient';
import { GeckoTerminalClient } from './geckoTerminalClient';
import { Candle } from '../analyzer/indicators/atr';
import { Redis } from 'ioredis';
import { appSettings } from '../../config/settings';

export class ScannerService {
  constructor(
    private readonly dexScreener: DexScreenerClient,
    private readonly geckoTerminal: GeckoTerminalClient,
    private readonly redis: Redis
  ) {}

  async scanTokenByAddress(tokenAddress: string): Promise<DexScreenerPair | null> {
    return this.dexScreener.getTokenData(tokenAddress);
  }

  async fetchNewPairs(): Promise<any[]> {
    return this.dexScreener.getLatestTokenProfiles();
  }

  async getCandles(
    network: string,
    poolAddress: string,
    timeframe: 'minute' | 'hour' | 'day' = 'minute',
    aggregate: number = 5
  ): Promise<Candle[]> {
    const cacheKey = `candles:${network}:${poolAddress}:${timeframe}:${aggregate}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // ignore JSON error and refetch
      }
    }

    const limit = Math.max(appSettings.ANALYZER_PARAMS.MIN_CANDLES, 50); // Get at least min candles + some buffer
    const candles = await this.geckoTerminal.getOHLCV(network, poolAddress, timeframe, aggregate, limit);
    
    if (candles.length > 0) {
      // Cache with 1 minute TTL to stay relatively fresh but avoid spamming
      await this.redis.set(cacheKey, JSON.stringify(candles), 'EX', 60); 
    }

    return candles;
  }
}
