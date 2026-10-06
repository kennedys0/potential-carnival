import { z } from 'zod';
import { calculateEMA } from './indicators/ema';
import { calculateRSI } from './indicators/rsi';
import { calculateATR, Candle } from './indicators/atr';
import { calculateVolumeSpikeRatio } from './indicators/volumeSpike';
import { appSettings } from '../../config/settings';

import { calculateVWAP } from './indicators/vwap';

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
  vwap: number;
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
  ): TechnicalIndicatorsSnapshot | null {
    if (candles.length < appSettings.ANALYZER_PARAMS.MIN_CANDLES) {
      return null;
    }

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) return null;

    const now = Date.now();
    const candleAgeMs = now - lastCandle.timestamp;
    if (candleAgeMs > appSettings.ANALYZER_PARAMS.MAX_STALE_CANDLE_AGE_MS) {
      return null;
    }

    const closes = candles.map((c) => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi14 = calculateRSI(closes, 14);
    const atr14 = calculateATR(candles, 14);
    const vwap = calculateVWAP(candles);
    const volumeSpikeRatio = calculateVolumeSpikeRatio(currentVolume, pastVolumes);

    // ATR-based dynamic risk bounds
    const calculatedStopLoss = Math.max(currentPrice - appSettings.RISK_MULTIPLIER_STOP_LOSS * atr14, currentPrice * appSettings.MAX_LOSS_PERCENTAGE);
    const riskDelta = currentPrice - calculatedStopLoss;
    const calculatedTp1 = currentPrice + appSettings.RISK_MULTIPLIER_TP1 * riskDelta;
    const calculatedTp2 = currentPrice + appSettings.RISK_MULTIPLIER_TP2 * riskDelta;

    return {
      ema9,
      ema21,
      rsi14,
      atr14,
      vwap,
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
      console.warn('AI unavailable: llmClient not configured');
      return null;
    }

    try {
      let analysis: AiAnalysis;
      if (typeof this.llmClient.analyze === 'function') {
        analysis = await this.llmClient.analyze({
          tokenSymbol,
          currentPrice,
          indicators,
          securityFlags,
        });
      } else {
        const prompt = `Analisa scalping untuk token ${tokenSymbol} pada harga $${currentPrice}. Indikator: EMA9=${indicators.ema9}, EMA21=${indicators.ema21}, RSI14=${indicators.rsi14}, ATR14=${indicators.atr14}, VWAP=${indicators.vwap}, VolumeSpike=${indicators.volumeSpikeRatio}x. StopLoss=$${indicators.calculatedStopLoss}, TP1=$${indicators.calculatedTp1}, TP2=$${indicators.calculatedTp2}. Flags: ${securityFlags.join(', ')}. Berikan response valid JSON sesuai schema.`;
        const response = await this.llmClient.messages.create({
          model: appSettings.FALLBACK_AI_MODEL,
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        });

        const parsed = JSON.parse(response.content[0].text);
        analysis = AiAnalysisSchema.parse(parsed);
      }

      // Validasi LLM output: SL < entry < TP
      if (analysis.verdict === 'BUY') {
        if (analysis.stop_loss_usd >= currentPrice) {
          console.warn(`LLM validation failed: SL (${analysis.stop_loss_usd}) >= Entry (${currentPrice})`);
          return null; // Reject inconsistency
        }
        const minTp = analysis.take_profit_levels.reduce((min, tp) => Math.min(min, tp.price_usd), Infinity);
        if (minTp <= currentPrice) {
          console.warn(`LLM validation failed: TP (${minTp}) <= Entry (${currentPrice})`);
          return null; // Reject inconsistency
        }
      }

      return analysis;
    } catch {
      return null; // Graceful fallback
    }
  }
}
