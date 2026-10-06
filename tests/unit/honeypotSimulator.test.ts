import { describe, it, expect, vi } from 'vitest';
import { HoneypotSimulator } from '../../src/modules/security/honeypotSimulator';

describe('HoneypotSimulator', () => {
  it('correctly calculates effective tax between quote and simulation', async () => {
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({
        inAmount: '100000000',
        outAmount: '98000000',
        priceImpactPct: '0.1',
      }),
      getSwapTransaction: vi.fn().mockResolvedValue('dummy-tx'),
    };
    const mockRpcConnection: any = {
      simulateTransaction: vi.fn().mockResolvedValue({
        value: { err: null, logs: [] },
      }),
    };

    const simulator = new HoneypotSimulator(mockJupiterClient, mockRpcConnection);
    const result = await simulator.simulateSell('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(result.canSell.value).toBe(true);
    expect(result.effectiveTaxPercent.value).toBeLessThan(5);
  });

  it('marks canSell as UNAVAILABLE when Jupiter route is not found or fails', async () => {
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockRejectedValue(new Error('No route found')),
    };
    const mockRpcConnection: any = {};

    const simulator = new HoneypotSimulator(mockJupiterClient, mockRpcConnection);
    const result = await simulator.simulateSell('DeadTokenMintAddress1111111111111111111111111');
    expect(result.canSell.value).toBe(null);
    expect(result.canSell.status).toBe('UNAVAILABLE');
    expect(result.effectiveTaxPercent.value).toBe(null);
  });
});
