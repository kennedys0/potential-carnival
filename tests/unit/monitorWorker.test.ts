import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMonitorWorker } from '../../src/queue/workers/monitorWorker';
import { logger } from '../../src/utils/logger';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name, processor, opts) => {
    return {
      name,
      processor,
      opts,
      close: vi.fn(),
      on: vi.fn(),
    };
  }),
}));

const mockRedis = {
  set: vi.fn().mockResolvedValue('OK'),
};

vi.mock('../../src/queue/connection', () => ({
  getRedisConnection: vi.fn(() => mockRedis),
}));

describe('MonitorWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prevents double-sell by only triggering close on OPEN or PARTIAL_EXIT statuses', async () => {
    const mockTradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([
        { id: 'pos-1', token_amount_raw: 1000000, entry_price_usd: 1.0, status: 'PENDING', sol_spent_lamports: 1000000000 },
        { id: 'pos-2', token_amount_raw: 1000000, entry_price_usd: 1.0, status: 'CLOSED', sol_spent_lamports: 1000000000 },
      ]),
    };
    const mockTraderService: any = {
      closePosition: vi.fn().mockResolvedValue(true),
    };
    const mockScannerService: any = {};
    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({ exit_params: { tp2_percent: 30, sl_percent: 8 } }),
    };
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '1500000000' }), // +50% PnL (hits TP2)
    };

    const worker: any = createMonitorWorker(mockTradeRepo, mockTraderService, mockScannerService, mockAutopilotRepo, mockJupiterClient);

    // Test PENDING
    await worker.processor({ data: { positionId: 'pos-1', userId: 111, tokenMint: 'tokenA' } });
    expect(mockTraderService.closePosition).not.toHaveBeenCalled();

    // Test CLOSED
    await worker.processor({ data: { positionId: 'pos-2', userId: 111, tokenMint: 'tokenA' } });
    expect(mockTraderService.closePosition).not.toHaveBeenCalled();
  });

  it('prevents double-sell by acquiring redis lock before calling closePosition', async () => {
    const mockTradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([
        { id: 'pos-lock', token_amount_raw: 1000000, entry_price_usd: 1.0, status: 'OPEN', sol_spent_lamports: 1000000000 },
      ]),
    };
    const mockTraderService: any = {
      closePosition: vi.fn().mockResolvedValue(true),
    };
    const mockScannerService: any = {};
    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({ exit_params: { tp2_percent: 30 } }),
    };
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '1500000000' }), // +50%
    };

    const worker: any = createMonitorWorker(mockTradeRepo, mockTraderService, mockScannerService, mockAutopilotRepo, mockJupiterClient);

    // Mock redis.set to return null (meaning lock is already acquired)
    mockRedis.set.mockResolvedValueOnce(null);

    await worker.processor({ data: { positionId: 'pos-lock', userId: 111, tokenMint: 'tokenA' } });
    
    // Should NOT call closePosition because lock was not acquired
    expect(mockTraderService.closePosition).not.toHaveBeenCalled();

    // Now mock redis to return 'OK'
    mockRedis.set.mockResolvedValueOnce('OK');
    await worker.processor({ data: { positionId: 'pos-lock', userId: 111, tokenMint: 'tokenA' } });
    
    // Should call closePosition this time
    expect(mockTraderService.closePosition).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pos-lock' }),
      expect.any(Number),
      100
    );
  });

  it('allows TP2 for PARTIAL_EXIT but ignores TP1', async () => {
    const mockTradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([
        { id: 'pos-3', token_amount_raw: 1000000, entry_price_usd: 1.0, status: 'PARTIAL_EXIT', sol_spent_lamports: 1000000000 },
      ]),
    };
    const mockTraderService: any = {
      closePosition: vi.fn().mockResolvedValue(true),
    };
    const mockScannerService: any = {};
    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({ exit_params: { tp1_percent: 15, tp2_percent: 30 } }),
    };
    const mockJupiterClient: any = {
      // Return 1.2 SOL -> +20% (hits TP1)
      getQuote: vi.fn().mockResolvedValue({ outAmount: '1200000000' }),
    };

    const worker: any = createMonitorWorker(mockTradeRepo, mockTraderService, mockScannerService, mockAutopilotRepo, mockJupiterClient);

    // Hit TP1 (+20%), but status is PARTIAL_EXIT -> shouldn't trigger
    await worker.processor({ data: { positionId: 'pos-3', userId: 111, tokenMint: 'tokenA' } });
    expect(mockTraderService.closePosition).not.toHaveBeenCalled();

    // Now change quote to +40% (hits TP2)
    mockJupiterClient.getQuote.mockResolvedValueOnce({ outAmount: '1400000000' });
    await worker.processor({ data: { positionId: 'pos-3', userId: 111, tokenMint: 'tokenA' } });
    expect(mockTraderService.closePosition).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pos-3' }),
      expect.any(Number),
      100
    );
  });
});
