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

export interface AnalyzeInput {
  tokenSymbol: string;
  currentPrice: number;
  indicators: TechnicalIndicatorsSnapshot;
  securityFlags: string[];
  systemPrompt?: string;
}

export class OpenAiCompatibleProvider {
  private unavailableUntil = 0;
  private consecutiveFailures = 0;

  constructor(private readonly config: OpenAiConfig) {}

  private recordFailure(): number {
    this.consecutiveFailures++;
    const cooldownMs = Math.min(
      BASE_PROVIDER_FAILURE_COOLDOWN_MS * Math.pow(2, this.consecutiveFailures - 1),
      MAX_PROVIDER_FAILURE_COOLDOWN_MS
    );
    this.unavailableUntil = Date.now() + cooldownMs;
    return cooldownMs;
  }

  async analyze(input: AnalyzeInput): Promise<AiAnalysis | null> {
    if (Date.now() < this.unavailableUntil) {
      return null;
    }

    const hasMacro = input.indicators.macroEma9 !== undefined && input.indicators.macroEma21 !== undefined;
    const macroLine = hasMacro
      ? `\n- Trend Makro (15m): EMA 9 = $${input.indicators.macroEma9}, EMA 21 = $${input.indicators.macroEma21}, RSI 14 = ${input.indicators.macroRsi14 ?? 'N/A'}`
      : '';

    const prompt = `
Kamu adalah Quantitative Scalper Solana. Berikan analisa teknikal scalping berbasis data berikut:
- Token: ${input.tokenSymbol}
- Harga saat ini: $${input.currentPrice}
- EMA 9: $${input.indicators.ema9}
- EMA 21: $${input.indicators.ema21}
- RSI 14: ${input.indicators.rsi14}
- ATR 14: $${input.indicators.atr14}
- Volume Spike Ratio: ${input.indicators.volumeSpikeRatio}x
- Stop Loss batas bawah: $${input.indicators.calculatedStopLoss}
- Take Profit 1: $${input.indicators.calculatedTp1}
- Take Profit 2: $${input.indicators.calculatedTp2}
- Risk flags dari security filter: ${input.securityFlags.join(', ') || 'None'}${macroLine}

ATURAN WAJIB:
1. Hanya gunakan data di atas. Dilarang mengarang fakta atau angka.
2. JIKA VERDICT = BUY, Stop Loss (stop_loss_usd) WAJIB lebih kecil (<) dari harga masuk ($${input.currentPrice}), dan Take Profit (take_profit_levels) WAJIB lebih besar (>) dari harga masuk.
3. [MULTI-TIMEFRAME]: Jika trend jangka pendek (5m) terlihat naik tapi trend makro (15m) turun (EMA9 < EMA21), BERHATI-HATILAH terhadap fakeout/dead cat bounce.
4. [ANTI-TRAP]: Jika ada 'Risk flags' yang menyebutkan Top 10 Holder memiliki supply sangat besar (>50%) atau LP bermasalah, VERDICT WAJIB AVOID!
5. Keluarkan HANYA JSON valid sesuai struktur berikut:
{
  "verdict": "BUY" | "WAIT" | "AVOID",
  "confidence": 0-100,
  "setup_type": "BREAKOUT" | "PULLBACK" | "MOMENTUM" | "REVERSAL" | "NONE",
  "entry_zone": { "min_usd": number, "max_usd": number },
  "take_profit_levels": [
    { "level": 1, "price_usd": number, "percentage": number },
    { "level": 2, "price_usd": number, "percentage": number }
  ],
  "stop_loss_usd": number,
  "risk_reward_ratio": number,
  "key_reasons": ["alasan 1", "alasan 2"],
  "red_flags": ["flag 1"],
  "invalidation_condition": "kondisi pembatalan setup",
  "estimated_holding_time": "durasi estimasi hold"
}
`.trim();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs ?? appSettings.LLM_REQUEST_TIMEOUT_MS);

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
              content: input.systemPrompt || 'You are a disciplined quantitative scalper. Respond strictly in valid JSON matching the requested schema. Do not include markdown formatting or explanation.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.2,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const cooldownMs = this.recordFailure();
        // Never log an upstream response body. Proxy error pages can contain
        // visitor IPs, request details, or provider diagnostics with secrets.
        try {
          await res.body?.cancel();
        } catch {
          // The response is already unusable; cancellation is best effort.
        }
        logger.error({
          status: res.status,
          statusText: res.statusText,
          contentType: res.headers.get('content-type'),
          providerHost: new URL(url).host,
          cooldownMs,
        }, 'OpenAI-compatible API request failed; provider temporarily disabled');
        return null;
      }

      const data: any = await res.json();
      let content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      // Extract JSON cleanly: handle markdown code blocks or surrounding text
      let cleaned = content.trim();
      const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
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
        logger.warn({
          token: input.tokenSymbol,
          error: parseErr.message,
        }, 'AI output validation failed for single token; skipping token without provider cooldown');
        return null;
      }
    } catch (err: any) {
      const cooldownMs = this.recordFailure();
      logger.warn({
        errorType: err instanceof Error ? err.name : 'UnknownError',
        providerHost: safeProviderHost(this.config.baseUrl),
        cooldownMs,
      }, 'Failed to reach AI provider; provider temporarily disabled');
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
