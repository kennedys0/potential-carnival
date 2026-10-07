import { AiAnalysis, AiAnalysisSchema, TechnicalIndicatorsSnapshot } from './analyzerService';
import { logger } from '../../utils/logger';

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface AnalyzeInput {
  tokenSymbol: string;
  currentPrice: number;
  indicators: TechnicalIndicatorsSnapshot;
  securityFlags: string[];
}

export class OpenAiCompatibleProvider {
  constructor(private readonly config: OpenAiConfig) {}

  async analyze(input: AnalyzeInput): Promise<AiAnalysis | null> {
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
- Risk flags dari security filter: ${input.securityFlags.join(', ') || 'None'}

ATURAN WAJIB:
1. Hanya gunakan data di atas. Dilarang mengarang fakta atau angka.
2. Keluarkan HANYA JSON valid sesuai struktur berikut:
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

    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 8000);

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
              content: 'You are a disciplined quantitative scalper. Respond strictly in valid JSON matching the requested schema.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorText = await res.text();
        logger.error({ status: res.status, errorText }, 'OpenAI-compatible API request failed');
        return null;
      }

      const data: any = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsedJson = JSON.parse(content);
      return AiAnalysisSchema.parse(parsedJson);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to parse or fetch AI analysis');
      return null;
    }
  }
}
