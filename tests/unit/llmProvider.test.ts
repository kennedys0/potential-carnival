import { describe, it, expect, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '../../src/modules/analyzer/llmProvider';

describe('OpenAiCompatibleProvider', () => {
  it('sends correct request payload to custom base URL and parses response', async () => {
    const mockResponsePayload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: 'BUY',
              confidence: 88,
              setup_type: 'BREAKOUT',
              entry_zone: { min_usd: 0.00004, max_usd: 0.000042 },
              take_profit_levels: [
                { level: 1, price_usd: 0.00005, percentage: 20 },
                { level: 2, price_usd: 0.00006, percentage: 40 },
              ],
              stop_loss_usd: 0.000035,
              risk_reward_ratio: 2.2,
              key_reasons: ['Breakout volume 3.5x', 'Bullish RSI rebound'],
              red_flags: [],
              invalidation_condition: 'Harga tembus di bawah $0.000035',
              estimated_holding_time: '15m - 1h',
            }),
          },
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponsePayload,
    });
    global.fetch = mockFetch;

    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-qwen-dummy1234567890abcdef',
      model: 'deepseek-v4-flash',
    });

    const result = await provider.analyze({
      tokenSymbol: 'TEST',
      currentPrice: 0.000041,
      indicators: {
        ema9: 0.000040,
        ema21: 0.000038,
        rsi14: 62,
        atr14: 0.000003,
        volumeSpikeRatio: 3.5,
        calculatedStopLoss: 0.000035,
        calculatedTp1: 0.000050,
        calculatedTp2: 0.000060,
      },
      securityFlags: [],
    });

    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('BUY');
    expect(result?.confidence).toBe(88);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-qwen-dummy1234567890abcdef',
        }),
      })
    );
  });
});
