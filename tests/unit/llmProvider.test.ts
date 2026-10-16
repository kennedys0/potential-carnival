import { describe, it, expect, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '../../src/modules/analyzer/llmProvider';
import { logger } from '../../src/utils/logger';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

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

  it('does not log an upstream HTML error body and opens a cooldown', async () => {
    const sensitiveHtml = '<html>visitor IP: 203.0.113.42 secret diagnostics</html>';
    const cancel = vi.fn().mockResolvedValue(undefined);
    const readBody = vi.fn().mockResolvedValue(sensitiveHtml);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 530,
      statusText: 'Origin DNS Error',
      headers: { get: vi.fn().mockReturnValue('text/html') },
      body: { cancel },
      text: readBody,
    });
    global.fetch = mockFetch;

    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://expired-tunnel.example/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const input = {
      tokenSymbol: 'TEST',
      currentPrice: 1,
      indicators: {
        ema9: 1,
        ema21: 1,
        rsi14: 50,
        atr14: 0.1,
        vwap: 1,
        volumeSpikeRatio: 1,
        calculatedStopLoss: 0.9,
        calculatedTp1: 1.1,
        calculatedTp2: 1.2,
      },
      securityFlags: [],
    };

    await expect(provider.analyze(input)).resolves.toBeNull();
    await expect(provider.analyze(input)).resolves.toBeNull();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(readBody).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(sensitiveHtml);
  });

  it('incorporates macro indicators and custom systemPrompt into request body', async () => {
    const mockResponsePayload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: 'WAIT',
              confidence: 65,
              setup_type: 'PULLBACK',
              entry_zone: { min_usd: 1.0, max_usd: 1.05 },
              take_profit_levels: [{ level: 1, price_usd: 1.2, percentage: 15 }],
              stop_loss_usd: 0.95,
              risk_reward_ratio: 3.0,
              key_reasons: ['Trend makro bearish', 'Menunggu konfirmasi'],
              red_flags: ['Macro 15m EMA9 < EMA21'],
              invalidation_condition: 'Harga tembus $0.95',
              estimated_holding_time: '30m',
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
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
    });

    await provider.analyze({
      tokenSymbol: 'SOLMACRO',
      currentPrice: 1.0,
      indicators: {
        ema9: 1.02,
        ema21: 1.01,
        rsi14: 55,
        atr14: 0.05,
        vwap: 1.0,
        volumeSpikeRatio: 2.1,
        calculatedStopLoss: 0.95,
        calculatedTp1: 1.15,
        calculatedTp2: 1.25,
        macroEma9: 0.98,
        macroEma21: 1.05,
        macroRsi14: 42,
      },
      securityFlags: ['Top 10 hold 30%'],
      systemPrompt: 'CUSTOM_SYSTEM_PROMPT_RULE',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.messages[0].content).toBe('CUSTOM_SYSTEM_PROMPT_RULE');
    // Format prompt diperbarui patch skema JSON 2026-10-15; pastikan data makro
    // tetap dimasukkan (bukan format lamanya).
    expect(body.messages[1].content).toContain('Trend Makro (15m):');
    expect(body.messages[1].content).toContain('$0.98');
    expect(body.messages[1].content).toContain('$1.05');
  });
});
