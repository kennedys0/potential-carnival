import { DexScreenerClient, DexScreenerPair } from './dexScreenerClient';
import { GeckoTerminalClient } from './geckoTerminalClient';
import type { Candle } from '../analyzer/indicators/atr';
import { Redis } from 'ioredis';
import { appSettings } from '../../config/settings';
import type { NewPoolCandidate } from './sniperPoolSelection';

export class ScannerService {
  constructor(
    private readonly dexScreener: DexScreenerClient,
    private readonly geckoTerminal: GeckoTerminalClient,
    private readonly redis: Redis
  ) {}

  async scanTokenByAddress(tokenAddress: string): Promise<DexScreenerPair | null> {
    return this.dexScreener.getTokenData(tokenAddress);
  }

  async scanTokensByAddresses(tokenAddresses: string[]): Promise<Map<string, DexScreenerPair>> {
    return this.dexScreener.getTokensData(tokenAddresses);
  }

  async scanSpecificPool(pairAddress: string): Promise<DexScreenerPair | null> {
    return this.dexScreener.getPairByAddress(pairAddress);
  }

  async fetchNewPairs(): Promise<NewPoolCandidate[]> {
    return this.geckoTerminal.getNewPools('solana', 1);
  }

  async getCandles(
    network: string,
    poolAddress: string,
    timeframe: 'minute' | 'hour' | 'day' = 'minute',
    aggregate: number = 5
  ): Promise<Candle[]> {
    // Ambil cukup candle agar hasil resample makro (faktor 5) tetap >= 21 candle
    // (syarat indikator makro di AnalyzerService). 110/5 = 22 makro candle.
    const limit = Math.max(appSettings.ANALYZER_PARAMS.MIN_CANDLES * 5 + 5, 110);
    const cacheKey = `candles:${network}:${poolAddress}:${timeframe}:${aggregate}:${limit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // ignore JSON error and refetch
      }
    }

    const candles = await this.geckoTerminal.getOHLCV(network, poolAddress, timeframe, aggregate, limit);
    
    if (candles.length > 0) {
      // Dynamic TTL based on aggregate to conserve GeckoTerminal quota (30 req/min)
      const ttlSeconds = aggregate >= 15 ? 900 : aggregate >= 5 ? 300 : 60;
      await this.redis.set(cacheKey, JSON.stringify(candles), 'EX', ttlSeconds); 
    }

    return candles;
  }
}
