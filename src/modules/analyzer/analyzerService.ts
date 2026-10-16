import { logger } from '../../utils/logger';
import { z } from 'zod';
import { calculateEMA } from './indicators/ema';
import { calculateRSI } from './indicators/rsi';
import { calculateATR, Candle } from './indicators/atr';
import { calculateVolumeSpikeRatio } from './indicators/volumeSpike';
import { appSettings } from '../../config/settings';
import { calculateVWAP } from './indicators/vwap';
import { formatUsd } from './llmProvider';

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
  // Jalur eksplisit "early momentum" untuk pool baru (< 21 candle): TIDAK memakai
  // EMA/RSI sintetis. Gate fallback memakai metrik real di earlyMomentum, bukan field di atas.
  isEarlyMomentum?: boolean;
  earlyMomentum?: {
    m5ChangePct: number;
    buysM5: number;
    sellsM5: number;
    m5VolumeUsd: number;
    priceVsFirstOpenPct: number;
  };
}

export interface MarketContext {
  priceChangeM5Pct?: number;
  buysM5?: number;
  sellsM5?: number;
  lastCandles?: Array<{ open: number; high: number; low: number; close: number }>;
}

export class AnalyzerService {
  constructor(private readonly llmClient?: any) {}

  /**
   * Cache vonis AI per token agar analisa tidak blocking setiap siklus.
   * Strategi stale-while-revalidate: vonis fresh (< TTL) dipakai instan (0 detik),
   * sekaligus trigger refresh background agar tetap hangat. Cache miss tetap
   * blocking seperti sebelumnya supaya perilaku first-sighting tidak berubah.
   */
  private readonly aiVerdictCache = new Map<string, { analysis: AiAnalysis; fetchedAt: number }>();
  private readonly aiInflight = new Map<string, Promise<AiAnalysis | null>>();
  // Batas ukuran cache: Map tidak punya TTL-eviction bawaan, jadi hapus entri terlama bila penuh.
  private static readonly AI_CACHE_MAX_ENTRIES = 500;

  private setAiCache(key: string, analysis: AiAnalysis): void {
    if (this.aiVerdictCache.size >= AnalyzerService.AI_CACHE_MAX_ENTRIES) {
      const oldest = this.aiVerdictCache.keys().next();
      if (!oldest.done) this.aiVerdictCache.delete(oldest.value);
    }
    this.aiVerdictCache.set(key, { analysis, fetchedAt: Date.now() });
  }

  // P1 (review GPT): fingerprint rejim pasar untuk cache key.
  // Vonis AI hanya dipakai ulang bila REJIM SAMA (arah tren, bucket RSI, bucket volume,
  // tekanan buy/sell). Rejim berubah -> key berubah -> cache miss -> AI dipanggil fresh.
  // Ini menyelesaikan dilema "TTL 5 menit terlalu lama vs cache tidak pernah hit":
  // TTL boleh panjang karena key-nya sendiri yang invalidasi saat pasar berubah.
  private buildRegimeFingerprint(
    indicators: TechnicalIndicatorsSnapshot,
    marketContext?: MarketContext
  ): string {
    const trendDir = indicators.ema9 > indicators.ema21 ? 'up' : 'dn';
    const rsiBucket = Number.isFinite(indicators.rsi14) ? Math.round(indicators.rsi14 / 10) : 'na';
    const volBucket = Number.isFinite(indicators.volumeSpikeRatio)
      ? Math.round(indicators.volumeSpikeRatio * 2)
      : 'na';
    const buys = Number(marketContext?.buysM5);
    const sells = Number(marketContext?.sellsM5);
    const pressure =
      Number.isFinite(buys) && Number.isFinite(sells) && sells > 0 ? (buys / sells).toFixed(1) : 'na';
    return `${trendDir}|rsi${rsiBucket}|vol${volBucket}|p${pressure}`;
  }

  async getAiAnalysisWithCache(
    tokenMint: string,
    tokenSymbol: string,
    currentPrice: number,
    indicators: TechnicalIndicatorsSnapshot,
    securityFlags: string[],
    marketContext?: MarketContext
  ): Promise<AiAnalysis | null> {
    const ttlMs = appSettings.SCANNER_PARAMS.AI_VERDICT_CACHE_TTL_MS;
    const cacheKey = `${tokenMint}:${this.buildRegimeFingerprint(indicators, marketContext)}`;
    const cached = this.aiVerdictCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      const ageSec = Math.round((Date.now() - cached.fetchedAt) / 1000);
      logger.debug({ token: tokenSymbol, ageSec }, 'AI cache HIT — pakai vonis tanpa nunggu LLM');
      // Refresh di background agar cache tetap hangat untuk siklus berikut
      this.refreshAiInBackground(cacheKey, tokenSymbol, currentPrice, indicators, securityFlags, marketContext);
      return cached.analysis;
    }
    // Cache miss: blocking seperti perilaku lama, lalu simpan ke cache
    const analysis = await this.analyzeWithLlm(tokenSymbol, currentPrice, indicators, securityFlags, marketContext);
    if (analysis) {
      this.setAiCache(cacheKey, analysis);
    }
    return analysis;
  }

  private refreshAiInBackground(
    cacheKey: string,
    tokenSymbol: string,
    currentPrice: number,
    indicators: TechnicalIndicatorsSnapshot,
    securityFlags: string[],
    marketContext?: MarketContext
  ): void {
    if (this.aiInflight.has(cacheKey)) return; // sudah ada refresh berjalan
    const p = this.analyzeWithLlm(tokenSymbol, currentPrice, indicators, securityFlags, marketContext)
      .then((analysis) => {
        if (analysis) {
          this.setAiCache(cacheKey, analysis);
          logger.debug({ token: tokenSymbol }, 'AI background refresh selesai, cache diperbarui');
        }
        return analysis;
      })
      .catch((err: any) => {
        logger.warn({ err: err?.message, token: tokenSymbol }, 'AI background refresh gagal (non-fatal)');
        return null;
      })
      .finally(() => {
        this.aiInflight.delete(cacheKey);
      });
    this.aiInflight.set(cacheKey, p);
    // Fire-and-forget: jangan biarkan unhandled rejection
    p.catch(() => {});
  }

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
    macroCandles?: Candle[],
    maxStaleMs?: number
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
    // P1 (review GPT): threshold stale disesuaikan timeframe — 30 menit terlalu longgar
    // untuk scalping 1m. Default 3 menit; pemanggil candle 5m (/scan) memakai 10 menit.
    const maxStale = maxStaleMs ?? appSettings.ANALYZER_PARAMS.MAX_STALE_CANDLE_AGE_MS;
    if (candleAgeMs > maxStale) {
      logger.warn({ candleAgeMs, maxStale }, 'Analyzer rejected stale candle data');
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
    securityFlags: string[],
    marketContext?: MarketContext,
    timeframeLabels?: { short: string; macro: string }
  ): Promise<AiAnalysis | null> {
    if (!this.llmClient) {
      logger.warn('AI unavailable: llmClient not configured');
      return null;
    }

    const systemPrompt = `Anda adalah AI Scalper Profesional untuk Solana. Analisis indikator teknikal & security flags berikut, lalu kembalikan keputusan BUY/WAIT/AVOID dalam format JSON murni.
ATURAN MUTLAK:
1. JIKA VERDICT = BUY:
   - Gunakan referensi stop_loss_usd di sekitar calculatedStopLoss ($${formatUsd(indicators.calculatedStopLoss)}) yang pasti < currentPrice ($${formatUsd(currentPrice)}).
   - Gunakan referensi take_profit_levels di sekitar calculatedTp1 ($${formatUsd(indicators.calculatedTp1)}) dan calculatedTp2 ($${formatUsd(indicators.calculatedTp2)}) yang pasti > currentPrice ($${formatUsd(currentPrice)}).
2. key_reasons WAJIB bahasa Indonesia, maksimal 5-7 kata per poin.
3. [MULTI-TIMEFRAME]: Jika EMA pendek (ema9 > ema21) naik tapi tren makro (macroEma9 < macroEma21) turun, waspadai fakeout/dead cat bounce (pilih WAIT/AVOID kecuali volumeSpikeRatio sangat kuat).
4. [ANTI-TRAP]: Jika securityFlags mencatat Top 10 Holder > 50%, VERDICT WAJIB AVOID.
5. Keluarkan HANYA JSON valid sesuai skema tanpa markdown block.
SKEMA JSON WAJIB — semua field berikut HARUS ada, tidak boleh di-skip:
{
  "verdict": "BUY" | "WAIT" | "AVOID",
  "confidence": <angka 0-100>,
  "setup_type": "BREAKOUT" | "PULLBACK" | "MOMENTUM" | "REVERSAL" | "NONE",
  "entry_zone": { "min_usd": <angka>, "max_usd": <angka> },
  "take_profit_levels": [ { "level": 1, "price_usd": <angka>, "percentage": <angka> } ],
  "stop_loss_usd": <angka>,
  "risk_reward_ratio": <angka>,
  "key_reasons": ["<string>", ...],
  "red_flags": ["<string>", ...],
  "invalidation_condition": "<string>",
  "estimated_holding_time": "<string>"
}
6. Untuk verdict WAIT/AVOID: entry_zone isi dengan currentPrice ($${formatUsd(currentPrice)}), take_profit_levels boleh array kosong [], stop_loss_usd = $${formatUsd(indicators.calculatedStopLoss)}, risk_reward_ratio = 0.`;

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
          marketContext,
          timeframeShortLabel: timeframeLabels?.short ?? '1m',
          timeframeMacroLabel: timeframeLabels?.macro ?? '5m',
        });
        if (!result) return null;
        const analysis: AiAnalysis = result;

        // FIX (review Claude minor): normalisasi confidence pecahan (0.85 -> 85).
        // Skema zod mengizinkan 0-100, jadi 0.85 lolos validasi tapi gagal >= 70 di RuleEvaluator.
        if (Number.isFinite(analysis.confidence) && analysis.confidence > 0 && analysis.confidence <= 1) {
          analysis.confidence = Math.round(analysis.confidence * 100);
        }

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
