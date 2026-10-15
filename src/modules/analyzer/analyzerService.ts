import { logger } from '../../utils/logger';
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
  take_profit_levels: z.array(
    z.object({ level: z.number(), price_usd: z.number(), percentage: z.number() })
  ),
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
  macroEma9?: number;
  macroEma21?: number;
  macroRsi14?: number;
}

export class AnalyzerService {
  constructor(private readonly llmClient?: any) {}

  private isValidCandle(candle: Candle): boolean {
    return (
      Number.isFinite(candle.timestamp) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      Number.isFinite(candle.volume) &&
      candle.timestamp > 0 &&
      candle.open > 0 &&
      candle.high > 0 &&
      candle.low > 0 &&
      candle.close > 0 &&
      candle.high >= candle.low
    );
  }

  calculateIndicators(
    candles: Candle[],
    currentPrice: number,
    currentVolume: number,
    pastVolumes: number[],
    macroCandles?: Candle[]
  ): TechnicalIndicatorsSnapshot | null {
    if (candles.length < appSettings.ANALYZER_PARAMS.MIN_CANDLES) {
      logger.warn({ candleCount: candles.length }, 'Analyzer rejected insufficient candle history');
      return null;
    }

    if (!candles.every((c) => this.isValidCandle(c))) {
      logger.warn('Analyzer rejected malformed candle data');
      return null;
    }
    if (candles.some((candle, index) => index > 0 && candle.timestamp <= candles[index - 1].timestamp)) {
      logger.warn('Analyzer rejected unordered or duplicate candle timestamps');
      return null;
    }
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(currentVolume) || currentVolume < 0) {
      logger.warn('Analyzer rejected invalid current market values');
      return null;
    }

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) return null;

    const now = Date.now();
    const candleAgeMs = now - lastCandle.timestamp;
    if (candleAgeMs > appSettings.ANALYZER_PARAMS.MAX_STALE_CANDLE_AGE_MS) {
      logger.warn({ candleAgeMs }, 'Analyzer rejected stale candle data');
      return null;
    }

    const closes = candles.map((c) => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi14 = calculateRSI(closes, 14);
    const atr14 = calculateATR(candles, 14);
    const vwap = calculateVWAP(candles);
    const volumeSpikeRatio = calculateVolumeSpikeRatio(currentVolume, pastVolumes);

    if (![ema9, ema21, rsi14, atr14, vwap, volumeSpikeRatio].every(Number.isFinite)) {
      logger.warn('Analyzer rejected non-finite indicator output');
      return null;
    }

    // Catatan: Pastikan MAX_LOSS_PERCENTAGE di settings.ts bernilai misal 0.90 (batas bawah 90% harga)
    // Jika MAX_LOSS_PERCENTAGE bernilai 0.10 (maks rugi 10%), gunakan (1 - appSettings.MAX_LOSS_PERCENTAGE)
    const lossFloorFactor =
      appSettings.MAX_LOSS_PERCENTAGE < 0.5
        ? 1 - appSettings.MAX_LOSS_PERCENTAGE
        : appSettings.MAX_LOSS_PERCENTAGE;

    const calculatedStopLoss = Math.max(
      currentPrice - appSettings.RISK_MULTIPLIER_STOP_LOSS * atr14,
      currentPrice * lossFloorFactor
    );
    const riskDelta = Math.max(currentPrice - calculatedStopLoss, currentPrice * 0.005); // cegah riskDelta <= 0
    const calculatedTp1 = currentPrice + appSettings.RISK_MULTIPLIER_TP1 * riskDelta;
    const calculatedTp2 = currentPrice + appSettings.RISK_MULTIPLIER_TP2 * riskDelta;

    const result: TechnicalIndicatorsSnapshot = {
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

    if (macroCandles && macroCandles.length >= 21 && macroCandles.every((c) => this.isValidCandle(c))) {
      const macroCloses = macroCandles.map((c) => c.close);
      const mEma9 = calculateEMA(macroCloses, 9);
      const mEma21 = calculateEMA(macroCloses, 21);
      const mRsi14 = calculateRSI(macroCloses, 14);
      if ([mEma9, mEma21, mRsi14].every(Number.isFinite)) {
        result.macroEma9 = mEma9;
        result.macroEma21 = mEma21;
        result.macroRsi14 = mRsi14;
      }
    }

    return result;
  }

  async analyzeWithLlm(
    tokenSymbol: string,
    currentPrice: number,
    indicators: TechnicalIndicatorsSnapshot,
    securityFlags: string[]
  ): Promise<AiAnalysis | null> {
    if (!this.llmClient) {
      logger.warn('AI unavailable: llmClient not configured');
      return null;
    }

    const systemPrompt = `Anda adalah AI Scalper Profesional untuk Solana. Analisis indikator teknikal & security flags berikut, lalu kembalikan keputusan BUY/WAIT/AVOID dalam format JSON murni.
ATURAN MUTLAK:
1. JIKA VERDICT = BUY:
   - Gunakan referensi stop_loss_usd di sekitar calculatedStopLoss (${indicators.calculatedStopLoss}) yang pasti < currentPrice (${currentPrice}).
   - Gunakan referensi take_profit_levels di sekitar calculatedTp1 (${indicators.calculatedTp1}) dan calculatedTp2 (${indicators.calculatedTp2}) yang pasti > currentPrice (${currentPrice}).
2. key_reasons WAJIB bahasa Indonesia, maksimal 5-7 kata per poin.
3. [MULTI-TIMEFRAME]: Jika EMA pendek (ema9 > ema21) naik tapi tren makro (macroEma9 < macroEma21) turun, waspadai fakeout/dead cat bounce (pilih WAIT/AVOID kecuali volumeSpikeRatio sangat kuat).
4. [ANTI-TRAP]: Jika securityFlags mencatat Top 10 Holder > 50%, VERDICT WAJIB AVOID.
5. Keluarkan HANYA JSON valid sesuai skema tanpa markdown block.`;

    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const result = await this.llmClient.analyze({
          tokenSymbol,
          currentPrice,
          indicators,
          securityFlags,
          systemPrompt,
        });
        if (!result) return null;
        const analysis: AiAnalysis = result;

        if (analysis.verdict === 'BUY') {
          if (!analysis.take_profit_levels || analysis.take_profit_levels.length === 0) {
            throw new Error('Inconsistent LLM output: take_profit_levels is empty');
          }

          if (analysis.stop_loss_usd >= currentPrice || analysis.stop_loss_usd <= 0) {
            throw new Error('Inconsistent LLM output: SL >= Entry');
          }

          const minTp = analysis.take_profit_levels.reduce((min, tp) => Math.min(min, tp.price_usd), Infinity);
          const maxTp = analysis.take_profit_levels.reduce((max, tp) => Math.max(max, tp.price_usd), -Infinity);

          if (!Number.isFinite(minTp) || minTp <= currentPrice) {
            throw new Error('Inconsistent LLM output: TP <= Entry');
          }

          const calculatedRisk = currentPrice - analysis.stop_loss_usd;
          const minActualRR = (minTp - currentPrice) / calculatedRisk;
          const maxActualRR = (maxTp - currentPrice) / calculatedRisk;

          // Cek apakah R:R yang diklaim AI masuk akal terhadap rentang TP1..TP2
          const isRrConsistent =
            Number.isFinite(analysis.risk_reward_ratio) &&
            analysis.risk_reward_ratio >= minActualRR - 1.0 &&
            analysis.risk_reward_ratio <= maxActualRR + 1.0;

          if (!isRrConsistent) {
            logger.warn(
              { claimedRR: analysis.risk_reward_ratio, actualRR: minActualRR, maxActualRR },
              'AI Hallucination detected in R:R math. Calibrating...'
            );
            analysis.confidence = Math.max(0, analysis.confidence - 20);
            analysis.risk_reward_ratio = minActualRR;
          }

          if (analysis.confidence > 90) {
            analysis.confidence = 90;
          }
        }

        return analysis;
      } catch (err: any) {
        logger.warn(`LLM attempt ${attempts} failed: ${err.message}`);
        if (attempts >= maxAttempts) {
          return null;
        }
        const delayMs = process.env.NODE_ENV === 'test' ? 10 : 1000;
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }

    return null;
  }
}
