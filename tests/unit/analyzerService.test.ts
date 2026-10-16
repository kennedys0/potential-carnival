import { describe, it, expect, vi } from 'vitest';
import { AnalyzerService, TechnicalIndicatorsSnapshot, AiAnalysisSchema } from '../../src/modules/analyzer/analyzerService';
import { Candle } from '../../src/modules/analyzer/indicators/atr';
import { appSettings } from '../../src/config/settings';

describe('AnalyzerService', () => {
  it('calculateIndicators returns null when data is insufficient', () => {
    const service = new AnalyzerService();
    // Provide fewer candles than MIN_CANDLES (21)
    const candles: Candle[] = Array(10).fill({ timestamp: Date.now(), open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 });
    
    const result = service.calculateIndicators(candles, 1.5, 150, []);
    expect(result).toBeNull();
  });

  it('calculateIndicators returns null when data is stale', () => {
    const service = new AnalyzerService();
    // Provide enough candles but stale timestamp
    const staleTime = Date.now() - (appSettings.ANALYZER_PARAMS.MAX_STALE_CANDLE_AGE_MS + 10000);
    const candles: Candle[] = Array(30).fill({ timestamp: staleTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 });
    
    const result = service.calculateIndicators(candles, 1.5, 150, []);
    expect(result).toBeNull();
  });

  it('analyzeWithLlm rejects inconsistent LLM output (SL >= Entry)', async () => {
    const mockLlmClient = {
      analyze: vi.fn().mockResolvedValue({
        verdict: 'BUY',
        confidence: 80,
        setup_type: 'MOMENTUM',
        entry_zone: { min_usd: 1, max_usd: 1.1 },
        take_profit_levels: [{ level: 1, price_usd: 1.5, percentage: 50 }],
        stop_loss_usd: 1.2, // INVALID: SL > Entry (1.0)
        risk_reward_ratio: 2,
        key_reasons: [],
        red_flags: [],
        invalidation_condition: 'none',
        estimated_holding_time: '1h'
      })
    };
    const service = new AnalyzerService(mockLlmClient);
    const indicators: TechnicalIndicatorsSnapshot = { ema9: 1, ema21: 1, rsi14: 50, atr14: 0.1, volumeSpikeRatio: 1, calculatedStopLoss: 0.8, calculatedTp1: 1.2, calculatedTp2: 1.5 };
    
    const result = await service.analyzeWithLlm('SOL', 1.0, indicators, []);
    expect(result).toBeNull();
  });

  it('analyzeWithLlm rejects inconsistent LLM output (TP <= Entry)', async () => {
    const mockLlmClient = {
      analyze: vi.fn().mockResolvedValue({
        verdict: 'BUY',
        confidence: 80,
        setup_type: 'MOMENTUM',
        entry_zone: { min_usd: 1, max_usd: 1.1 },
        take_profit_levels: [{ level: 1, price_usd: 0.9, percentage: 50 }], // INVALID: TP < Entry (1.0)
        stop_loss_usd: 0.8,
        risk_reward_ratio: 2,
        key_reasons: [],
        red_flags: [],
        invalidation_condition: 'none',
        estimated_holding_time: '1h'
      })
    };
    const service = new AnalyzerService(mockLlmClient);
    const indicators: TechnicalIndicatorsSnapshot = { ema9: 1, ema21: 1, rsi14: 50, atr14: 0.1, volumeSpikeRatio: 1, calculatedStopLoss: 0.8, calculatedTp1: 1.2, calculatedTp2: 1.5 };
    
    const result = await service.analyzeWithLlm('SOL', 1.0, indicators, []);
    expect(result).toBeNull();
  });

  it('does not immediately retry when the provider reports it is unavailable', async () => {
    const mockLlmClient = {
      analyze: vi.fn().mockResolvedValue(null),
    };
    const service = new AnalyzerService(mockLlmClient);
    const indicators: TechnicalIndicatorsSnapshot = {
      ema9: 1,
      ema21: 1,
      rsi14: 50,
      atr14: 0.1,
      vwap: 1,
      volumeSpikeRatio: 1,
      calculatedStopLoss: 0.8,
      calculatedTp1: 1.2,
      calculatedTp2: 1.5,
    };

    await expect(service.analyzeWithLlm('SOL', 1.0, indicators, [])).resolves.toBeNull();
    expect(mockLlmClient.analyze).toHaveBeenCalledTimes(1);
  });
});

describe('AI verdict cache regime fingerprint (P1)', () => {
  const waitVerdict = {
    verdict: 'WAIT',
    confidence: 60,
    setup_type: 'NONE',
    entry_zone: { min_usd: 1, max_usd: 1 },
    take_profit_levels: [],
    stop_loss_usd: 0.9,
    risk_reward_ratio: 0,
    key_reasons: [],
    red_flags: [],
    invalidation_condition: 'none',
    estimated_holding_time: '1h',
  };

  const baseIndicators: TechnicalIndicatorsSnapshot = {
    ema9: 1.1,
    ema21: 1.0,
    rsi14: 55,
    atr14: 0.1,
    vwap: 1.0,
    volumeSpikeRatio: 2,
    calculatedStopLoss: 0.9,
    calculatedTp1: 1.2,
    calculatedTp2: 1.5,
  };
  const marketCtx: any = { buysM5: 8, sellsM5: 2 };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('serves cached verdict when regime is unchanged (HIT)', async () => {
    const mockLlmClient = { analyze: vi.fn().mockResolvedValue({ ...waitVerdict }) };
    const service = new AnalyzerService(mockLlmClient);

    const r1 = await service.getAiAnalysisWithCache('mintX', 'TKN', 1.0, baseIndicators, [], marketCtx);
    expect(r1?.verdict).toBe('WAIT');
    expect(mockLlmClient.analyze).toHaveBeenCalledTimes(1); // miss -> blocking

    // Ubah mock: bila HIT, vonis lama (WAIT) yang dikembalikan, bukan BUY baru
    mockLlmClient.analyze.mockResolvedValue({ ...waitVerdict, verdict: 'BUY' });
    const r2 = await service.getAiAnalysisWithCache('mintX', 'TKN', 1.0, baseIndicators, [], marketCtx);
    expect(r2?.verdict).toBe('WAIT'); // HIT: rejim sama -> cache dipakai
  });

  it('forces fresh AI call when regime changes (MISS on regime flip)', async () => {
    const mockLlmClient = { analyze: vi.fn().mockResolvedValue({ ...waitVerdict }) };
    const service = new AnalyzerService(mockLlmClient);

    await service.getAiAnalysisWithCache('mintY', 'TKN', 1.0, baseIndicators, [], marketCtx);
    expect(mockLlmClient.analyze).toHaveBeenCalledTimes(1);

    // Rejim berbalik (tren turun): key fingerprint berubah -> MISS -> blocking call
    const flipped = { ...baseIndicators, ema9: 0.9 };
    await service.getAiAnalysisWithCache('mintY', 'TKN', 1.0, flipped, [], marketCtx);
    // MISS bersifat blocking (di-await), jadi hitungan naik deterministik segera setelah await
    expect(mockLlmClient.analyze).toHaveBeenCalledTimes(2);

    // Tekanan beli runtuh juga mengubah fingerprint
    const noPressure = { ...baseIndicators };
    await service.getAiAnalysisWithCache('mintY', 'TKN', 1.0, noPressure, [], { buysM5: 1, sellsM5: 9 });
    expect(mockLlmClient.analyze).toHaveBeenCalledTimes(3);
    await sleep(50); // biarkan background refresh (dari HIT manapun) selesai tanpa mengganggu hitungan
  });
});
