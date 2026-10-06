import { describe, it, expect } from 'vitest';
import { calculateEMA } from '../../src/modules/analyzer/indicators/ema';
import { calculateRSI } from '../../src/modules/analyzer/indicators/rsi';
import { calculateATR } from '../../src/modules/analyzer/indicators/atr';
import { calculateVolumeSpikeRatio } from '../../src/modules/analyzer/indicators/volumeSpike';

describe('Technical Indicators', () => {
  it('calculates EMA accurately', () => {
    const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const ema = calculateEMA(prices, 5);
    expect(ema).toBeGreaterThan(16);
    expect(ema).toBeLessThanOrEqual(20);
  });

  it('calculates RSI within 0 to 100 range', () => {
    const prices = [10, 12, 11, 13, 14, 15, 13, 12, 14, 16, 17, 18, 19, 20, 21];
    const rsi = calculateRSI(prices, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it('calculates ATR greater than 0 for volatile candles', () => {
    const candles = [
      { high: 10, low: 8, close: 9 },
      { high: 12, low: 9, close: 11 },
      { high: 13, low: 10, close: 12 },
    ];
    const atr = calculateATR(candles, 2);
    expect(atr).toBeGreaterThan(0);
  });

  it('calculates volume spike ratio correctly', () => {
    const volumes = [100, 100, 100, 100, 100];
    const ratio = calculateVolumeSpikeRatio(300, volumes);
    expect(ratio).toBe(3.0);
  });
});
