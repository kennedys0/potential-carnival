import { z } from 'zod';
import { calculateEMA } from './indicators/ema';
import { calculateRSI } from './indicators/rsi';
import { calculateATR, Candle } from './indicators/atr';
import { calculateVolumeSpikeRatio } from './indicators/volumeSpike';

export const AiAnalysisSchema = z.object({
  verdict: z.enum(['BUY', 'WAIT', 'AVOID']),
  confidence: z.number().min(0).max(100),
  setup_type: z.enum(['BREAKOUT', 'PULLBACK', 'MOMENTUM', 'REVERSAL', 'NONE']),
  entry_zone: z.object({ min_usd: z.number(), max_usd: z.number() }),
  take_profit_levels: z.array(z.object({ level: z.number(), price_usd: z.number(), percentage: z.number() })),
  stop_loss_usd: z.number(),
  risk_reward_ratio: z.number(),
  key_reasons: z.array(z.string()),
  red_flags: z.array(z.string()),
  invalidation_condition: z.string(),
  estimated_holding_time: z.string(),
});

export type AiAnalysis = z.infer<typeof AiAnalysisSchema>;

export interface TechnicalIndicatorsSnapshot {
  ema9: number;
  ema21: number;
  rsi14: number;
  atr14: number;
  volumeSpikeRatio: number;
  calculatedStopLoss: number;
  calculatedTp1: number;
  calculatedTp2: number;
}

export class AnalyzerService {
  constructor(private readonly llmClient?: any) {}

  calculateIndicators(
    candles: Candle[],
    currentPrice: number,
    currentVolume: number,
    pastVolumes: number[]
  ): TechnicalIndicatorsSnapshot {
    const closes = candles.map((c) => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi14 = calculateRSI(closes, 14);
    const atr14 = calculateATR(candles, 14);
    const volumeSpikeRatio = calculateVolumeSpikeRatio(currentVolume, pastVolumes);

    // ATR-based dynamic risk bounds (non-hallucinated math)
    const calculatedStopLoss = Math.max(currentPrice - 1.5 * atr14, currentPrice * 0.9);
    const riskDelta = currentPrice - calculatedStopLoss;
    const calculatedTp1 = currentPrice + 1.5 * riskDelta;
    const calculatedTp2 = currentPrice + 3.0 * riskDelta;

    return {
      ema9,
      ema21,
      rsi14,
      atr14,
      volumeSpikeRatio,
      calculatedStopLoss,
      calculatedTp1,
      calculatedTp2,
    };
  }

  async analyzeWithLlm(
    tokenSymbol: string,
    currentPrice: number,
    indicators: TechnicalIndicatorsSnapshot,
    securityFlags: string[]
  ): Promise<AiAnalysis | null> {
    if (!this.llmClient) {
      // Fallback programatik jika LLM tidak aktif / unavailable
      const verdict =
        indicators.rsi14 > 45 && indicators.rsi14 < 70 && indicators.ema9 > indicators.ema21
          ? 'BUY'
          : 'WAIT';
      const confidence = verdict === 'BUY' ? 75 : 50;

      return {
        verdict,
        confidence,
        setup_type: 'MOMENTUM',
        entry_zone: { min_usd: currentPrice * 0.99, max_usd: currentPrice * 1.01 },
        take_profit_levels: [
          { level: 1, price_usd: indicators.calculatedTp1, percentage: 15 },
          { level: 2, price_usd: indicators.calculatedTp2, percentage: 30 },
        ],
        stop_loss_usd: indicators.calculatedStopLoss,
        risk_reward_ratio: 2.0,
        key_reasons: [
          `EMA9 ($${indicators.ema9.toFixed(6)}) ${indicators.ema9 >= indicators.ema21 ? 'di atas' : 'di bawah'} EMA21`,
          `RSI14 netral-bullish pada level ${indicators.rsi14.toFixed(1)}`,
          `Volume Spike Ratio ${indicators.volumeSpikeRatio}x`,
        ],
        red_flags: securityFlags,
        invalidation_condition: `Harga tembus di bawah SL $${indicators.calculatedStopLoss.toFixed(6)}`,
        estimated_holding_time: '5m - 30m',
      };
    }

    try {
      // Panggilan LLM dengan structured JSON output
      const prompt = `Analisa scalping untuk token ${tokenSymbol} pada harga $${currentPrice}. Indikator: EMA9=${indicators.ema9}, EMA21=${indicators.ema21}, RSI14=${indicators.rsi14}, ATR14=${indicators.atr14}, VolumeSpike=${indicators.volumeSpikeRatio}x. StopLoss=$${indicators.calculatedStopLoss}, TP1=$${indicators.calculatedTp1}, TP2=$${indicators.calculatedTp2}. Flags: ${securityFlags.join(', ')}. Berikan response valid JSON sesuai schema.`;
      const response = await this.llmClient.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const parsed = JSON.parse(response.content[0].text);
      return AiAnalysisSchema.parse(parsed);
    } catch {
      return null; // Graceful fallback to null without crashing
    }
  }
}
