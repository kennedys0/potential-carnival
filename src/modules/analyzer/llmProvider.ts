import { AiAnalysis, AiAnalysisSchema, TechnicalIndicatorsSnapshot } from './analyzerService';
import { logger } from '../../utils/logger';
import { appSettings } from '../../config/settings';

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

const BASE_PROVIDER_FAILURE_COOLDOWN_MS = 10_000;
const MAX_PROVIDER_FAILURE_COOLDOWN_MS = 5 * 60_000;

export interface MarketContextInput {
  priceChangeM5Pct?: number;
  buysM5?: number;
  sellsM5?: number;
  lastCandles?: Array<{ open: number; high: number; low: number; close: number }>;
}

export interface AnalyzeInput {
  tokenSymbol: string;
  currentPrice: number;
  indicators: TechnicalIndicatorsSnapshot;
  securityFlags: string[];
  systemPrompt?: string;
  marketContext?: MarketContextInput;
  timeframeShortLabel?: string;
  timeframeMacroLabel?: string;
}

/**
 * Mencegah JavaScript mengubah angka mikro (misal 0.000000045) menjadi "4.5e-8"
 * yang sering membuat LLM salah baca jumlah nol (halusinasi desimal).
 */
function formatUsd(val: number): string {
  if (!Number.isFinite(val)) return '0';
  if (val === 0) return '0';
  if (Math.abs(val) < 0.000001) return val.toFixed(10).replace(/\.?0+$/, '');
  if (Math.abs(val) < 0.01) return val.toFixed(8).replace(/\.?0+$/, '');
  if (Math.abs(val) < 1) return val.toFixed(6).replace(/\.?0+$/, '');
  return val.toFixed(4).replace(/\.?0+$/, '');
}

function pctDiff(current: number, reference: number): string {
  if (!Number.isFinite(current) || !Number.isFinite(reference) || reference <= 0) return '0.00%';
  const diff = ((current - reference) / reference) * 100;
  return `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%`;
}

/** Deskripsikan bentuk 1 candle untuk AI: arah + deteksi wick distribusi/akumulasi. */
function describeCandle(c: { open: number; high: number; low: number; close: number }): string {
  if (![c.open, c.high, c.low, c.close].every(Number.isFinite) || c.open <= 0) return 'n/a';
  const chg = ((c.close - c.open) / c.open) * 100;
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  let shape = 'netral';
  if (body > 0) {
    if (upperWick > 2 * body && chg > 0) shape = 'wick atas panjang (distribusi/tekanan jual)';
    else if (lowerWick > 2 * body && chg < 0) shape = 'wick bawah panjang (akumulasi/tekanan beli)';
    else if (chg > 0) shape = 'bullish';
    else shape = 'bearish';
  }
  return `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% ${shape}`;
}

/** Rangkai konteks orderflow & price action cepat jadi 1-2 baris prompt. */
function formatMarketContext(mc?: MarketContextInput): string {
  if (!mc) return '';
  const parts: string[] = [];
  if (Number.isFinite(mc.priceChangeM5Pct)) {
    const v = mc.priceChangeM5Pct as number;
    parts.push(`Perubahan harga 5m: ${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
  }
  if (Number.isFinite(mc.buysM5) && Number.isFinite(mc.sellsM5)) {
    const buys = mc.buysM5 as number;
    const sells = mc.sellsM5 as number;
    const total = buys + sells;
    const ratio = total > 0 ? (buys / total) * 100 : 50;
    parts.push(`Transaksi 5m: ${buys} beli vs ${sells} jual (${ratio.toFixed(0)}% beli)`);
  }
  if (mc.lastCandles && mc.lastCandles.length > 0) {
    const desc = mc.lastCandles.map(describeCandle).join(' -> ');
    parts.push(`3 candle terakhir: ${desc}`);
  }
  if (parts.length === 0) return '';
  return `\n- Orderflow & Price Action: ${parts.join(' | ')}`;
}

export class OpenAiCompatibleProvider {
  private unavailableUntil = 0;
  private consecutiveFailures = 0;

  constructor(private readonly config: OpenAiConfig) {}

  private recordFailure(forceImmediateCooldown = false): number {
    this.consecutiveFailures++;
    // Jangan langsung matikan provider jika baru gagal/timeout 1x karena lonjakan trafik sesaat,
    // kecuali error HTTP 401/403/429/5xx (forceImmediateCooldown = true).
    if (!forceImmediateCooldown && this.consecutiveFailures < 2) {
      return 0;
    }
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const cooldownMs = Math.min(
      BASE_PROVIDER_FAILURE_COOLDOWN_MS * Math.pow(2, exponent),
      MAX_PROVIDER_FAILURE_COOLDOWN_MS
    );
    this.unavailableUntil = Date.now() + cooldownMs;
    return cooldownMs;
  }

  async analyze(input: AnalyzeInput): Promise<AiAnalysis | null> {
    if (Date.now() < this.unavailableUntil) {
      return null;
    }

    const { currentPrice, indicators, securityFlags } = input;
    const shortLabel = input.timeframeShortLabel ?? '5m';
    const macroLabel = input.timeframeMacroLabel ?? '15m';
    const hasMacro = indicators.macroEma9 !== undefined && indicators.macroEma21 !== undefined;
    const macroTrendStatus = hasMacro
      ? indicators.macroEma9! >= indicators.macroEma21!
        ? 'BULLISH (EMA9 >= EMA21)'
        : 'BEARISH (EMA9 < EMA21)'
      : 'N/A';

    const macroLine = hasMacro
      ? `\n- Trend Makro (${macroLabel}): ${macroTrendStatus} | EMA9: $${formatUsd(indicators.macroEma9!)} | EMA21: $${formatUsd(indicators.macroEma21!)} | RSI14: ${indicators.macroRsi14?.toFixed(2) ?? 'N/A'}`
      : '';

    const shortTrendStatus =
      indicators.ema9 >= indicators.ema21 ? 'BULLISH (EMA9 >= EMA21)' : 'BEARISH (EMA9 < EMA21)';

    // Sajikan data matang beserta jarak persentasenya agar AI tidak perlu mengira-ngira hitungan di kepala
    const prompt = `
Data Kuantitatif Token Solana:
- Token: ${input.tokenSymbol}
- Harga Saat Ini (Entry): $${formatUsd(currentPrice)}
- Trend Jangka Pendek (${shortLabel}): ${shortTrendStatus}
- EMA 9: $${formatUsd(indicators.ema9)} (Jarak harga ke EMA9: ${pctDiff(currentPrice, indicators.ema9)})
- EMA 21: $${formatUsd(indicators.ema21)} (Jarak harga ke EMA21: ${pctDiff(currentPrice, indicators.ema21)})
- VWAP: $${formatUsd(indicators.vwap)} (Posisi harga vs VWAP: ${pctDiff(currentPrice, indicators.vwap)})
- RSI 14: ${indicators.rsi14.toFixed(2)}
- ATR 14: $${formatUsd(indicators.atr14)}
- Volume Spike Ratio: ${indicators.volumeSpikeRatio.toFixed(2)}x${macroLine}${formatMarketContext(input.marketContext)}
- Referensi Stop Loss (ATR): $${formatUsd(indicators.calculatedStopLoss)}
- Referensi Take Profit 1: $${formatUsd(indicators.calculatedTp1)}
- Referensi Take Profit 2: $${formatUsd(indicators.calculatedTp2)}
- Security Risk Flags: ${securityFlags.length > 0 ? securityFlags.join(', ') : 'None'}

Berikan analisis objek JSON sesuai skema yang diminta pada instruksi sistem.
`.trim();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const controller = new AbortController();
      timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs ?? appSettings.LLM_REQUEST_TIMEOUT_MS
      );

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'system',
              content:
                input.systemPrompt ||
                'You are a disciplined quantitative scalper. Respond strictly in valid JSON matching the requested schema. Do not include markdown formatting or explanation.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.1,
          max_tokens: 500,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const cooldownMs = this.recordFailure(true);
        try {
          await res.body?.cancel();
        } catch {
          // Best effort
        }
        logger.error(
          {
            status: res.status,
            statusText: res.statusText,
            contentType: res.headers.get('content-type'),
            providerHost: safeProviderHost(url),
            cooldownMs,
          },
          'OpenAI-compatible API request failed; provider temporarily disabled'
        );
        return null;
      }

      const data: any = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string') return null;

      // Bersihkan blok <think>...</think> jika memakai model reasoning (misal DeepSeek)
      let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (codeBlockMatch) {
        cleaned = codeBlockMatch[1].trim();
      } else {
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          cleaned = cleaned.substring(firstBrace, lastBrace + 1);
        }
      }

      try {
        const parsedJson = JSON.parse(cleaned);
        const analysis = AiAnalysisSchema.parse(parsedJson);
        this.unavailableUntil = 0;
        this.consecutiveFailures = 0;
        return analysis;
      } catch (parseErr: any) {
        logger.warn(
          {
            token: input.tokenSymbol,
            error: parseErr.message,
          },
          'AI output validation failed for single token; throwing for retry'
        );
        // Lempar error agar loop retry di AnalyzerService bisa mencoba ulang (jika masih ada kuota attempt)
        throw new Error(`Invalid AI JSON output: ${parseErr.message}`);
      }
    } catch (err: any) {
      // Jika error berasal dari JSON parse/schema validation, teruskan ke AnalyzerService tanpa menghukum status provider
      if (err instanceof Error && err.message.startsWith('Invalid AI JSON output:')) {
        throw err;
      }

      const cooldownMs = this.recordFailure(false);
      logger.warn(
        {
          errorType: err instanceof Error ? err.name : 'UnknownError',
          providerHost: safeProviderHost(this.config.baseUrl),
          cooldownMs,
        },
        'Failed to reach AI provider'
      );
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

function safeProviderHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'invalid-url';
  }
}
