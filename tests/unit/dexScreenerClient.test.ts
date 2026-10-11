import { describe, it, expect, vi } from 'vitest';
import { DexScreenerClient } from '../../src/modules/scanner/dexScreenerClient';

describe('DexScreenerClient', () => {
  it('parses real token response correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pairs: [
          {
            chainId: 'solana',
            baseToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin' },
            priceUsd: '1.00',
            liquidity: { usd: 25000000 },
            volume: { m5: 12000, h1: 150000, h24: 2500000 },
            priceChange: { m5: 0.1, h1: 0.2, h24: 0.05 },
            pairCreatedAt: Date.now() - 3600000,
          },
        ],
      }),
    });
    global.fetch = mockFetch;

    const client = new DexScreenerClient();
    const data = await client.getTokenData('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(data?.baseToken.symbol).toBe('USDC');
    expect(data?.liquidity.usd).toBe(25000000);
    expect(mockFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not use a higher-liquidity pair where the requested token is only the quote asset', async () => {
    const requested = 'RequestedToken111111111111111111111111111111';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pairs: [
          {
            chainId: 'solana',
            baseToken: { address: 'OtherToken111111111111111111111111111111111', symbol: 'OTHER', name: 'Other' },
            quoteToken: { address: requested },
            priceUsd: '999',
            liquidity: { usd: 1_000_000 },
          },
          {
            chainId: 'solana',
            baseToken: { address: requested, symbol: 'RIGHT', name: 'Requested' },
            priceUsd: '2',
            liquidity: { usd: 100_000 },
          },
        ],
      }),
    }) as any;

    const data = await new DexScreenerClient().getTokenData(requested);
    expect(data?.baseToken.symbol).toBe('RIGHT');
    expect(data?.priceUsd).toBe('2');
  });
});
