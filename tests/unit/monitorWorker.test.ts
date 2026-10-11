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
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  eval: vi.fn().mockResolvedValue(1),
};

const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue(true),
};

vi.mock('../../src/queue/connection', () => ({
  getRedisConnection: vi.fn(() => mockRedis),
}));

describe('MonitorWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.get.mockResolvedValue(null);
  });

  it('prevents double-sell by only triggering close on OPEN or PARTIAL_EXIT statuses', async () => {
    const mockTradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([
        { id: 'pos-1', token_amount_raw: 1000000, remaining_raw: 1000000, entry_price_usd: 1.0, status: 'PENDING', sol_spent_lamports: 1000000000 },
        { id: 'pos-2', token_amount_raw: 1000000, remaining_raw: 1000000, entry_price_usd: 1.0, status: 'CLOSED', sol_spent_lamports: 1000000000 },
      ]),
    };
    const mockTraderService: any = {
      closePosition: vi.fn().mockResolvedValue(true),
    };
    const mockScannerService: any = {
      scanTokenByAddress: vi.fn().mockResolvedValue({ priceUsd: '1.5' }),
    };
    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({ exit_params: { tp2_percent: 30, sl_percent: 8 } }),
    };
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '1500000000' }), // +50% PnL (hits TP2)
    };

    const worker: any = createMonitorWorker(mockTradeRepo, mockTraderService, mockScannerService, mockAutopilotRepo, mockJupiterClient, mockBotApi);

    // Test PENDING
    await worker.processor({ data: { positionId: 'pos-1', userId: 111, tokenMint: 'tokenA' } });
    expect(mockTraderService.closePosition).not.toHaveBeenCalled();

    // Test CLOSED
    await worker.processor({ data: { positionId: 'pos-2', userId: 111, tokenMint: 'tokenA' } });
    expect(mockTraderService.closePosition).not.toHaveBeenCalled();
  });

  it('prevents double-sell by local redis lock (kills M1-monitor-no-lock)', async () => {
    const mockTradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([
        { id: 'pos-lock', source: 'AUTOPILOT', token_amount_raw: 1000000, remaining_raw: '1000000', entry_price_usd: 1.0, status: 'OPEN', sol_spent_lamports: 1000000000 },
      ]),
    };
    const mockTraderService: any = {
      closePosition: vi.fn().mockResolvedValue(true),
    };
    const mockScannerService: any = {
      scanTokenByAddress: vi.fn().mockResolvedValue({ priceUsd: '1.5' }),
    };
    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({ exit_params: { tp2_percent: 30 } }),
    };
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '1500000000' }), // +50%
    };

    const worker: any = createMonitorWorker(mockTradeRepo, mockTraderService, mockScannerService, mockAutopilotRepo, mockJupiterClient, mockBotApi);

    // Mock redis.set to return null for local lock (lock already acquired)
    mockRedis.set.mockResolvedValueOnce(null);

    await worker.processor({ data: { positionId: 'pos-lock', userId: 111, tokenMint: 'tokenA' } });
    
    // Should NOT call closePosition because local lock stopped it
    expect(mockTraderService.closePosition).not.toHaveBeenCalled();
  });

  it('prevents double-sell gracefully if traderService throws terkunci', async () => {
    const mockTradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([
        { id: 'pos-lock', source: 'AUTOPILOT', token_amount_raw: 1000000, remaining_raw: '1000000', entry_price_usd: 1.0, status: 'OPEN', sol_spent_lamports: 1000000000 },
      ]),
    };
    const mockTraderService: any = {
      closePosition: vi.fn().mockRejectedValue(new Error('Penutupan posisi sedang diproses (terkunci).')),
    };
    const mockScannerService: any = {
      scanTokenByAddress: vi.fn().mockResolvedValue({ priceUsd: '1.5' }),
    };
    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({ exit_params: { tp2_percent: 30 } }),
    };
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '1500000000' }), // +50%
    };

    const worker: any = createMonitorWorker(mockTradeRepo, mockTraderService, mockScannerService, mockAutopilotRepo, mockJupiterClient, mockBotApi);

    // Call processor. It should catch the 'terkunci' error and NOT throw it to BullMQ
    await expect(worker.processor({ data: { positionId: 'pos-lock', userId: 111, tokenMint: 'tokenA' } })).resolves.toBeUndefined();
    
    // We can verify it was actually called
    expect(mockTraderService.closePosition).toHaveBeenCalled();
  });

  it('allows TP2 for PARTIAL_EXIT but ignores TP1', async () => {
    const mockTradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([
        { id: 'pos-3', source: 'AUTOPILOT', token_amount_raw: 1000000, remaining_raw: '1000000', entry_price_usd: 1.0, status: 'PARTIAL_EXIT', sol_spent_lamports: 1000000000 },
      ]),
    };
    const mockTraderService: any = {
      closePosition: vi.fn().mockResolvedValue(true),
    };
    const mockScannerService: any = {
      scanTokenByAddress: vi.fn().mockResolvedValue({ priceUsd: '1.5' }),
    };
    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({ exit_params: { tp1_percent: 15, tp2_percent: 30 } }),
    };
    const mockJupiterClient: any = {
      // Return 1.2 SOL -> +20% (hits TP1)
      getQuote: vi.fn().mockResolvedValue({ outAmount: '1200000000' }),
    };

    const worker: any = createMonitorWorker(mockTradeRepo, mockTraderService, mockScannerService, mockAutopilotRepo, mockJupiterClient, mockBotApi);

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
  it('uses sniper exit snapshot instead of Trending settings', async () => {
    const trade = {
      id: 'sniper-position', token_mint: 'tokenS', token_symbol: 'SNIP',
      status: 'OPEN', source: 'AUTOPILOT', strategy: 'NEW_TOKEN_SNIPER', is_dry_run: true,
      entry_price_usd: 1, highest_pnl_percent: 0,
      exit_policy_snapshot: {
        enabled: true, tp1_percent: 20, tp2_percent: 20, sl_percent: 10,
        trailing_stop_enabled: false,
      },
    };
    const tradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([trade]),
      updateTradeStatus: vi.fn().mockResolvedValue(undefined),
    };
    const traderService: any = { closePosition: vi.fn().mockResolvedValue('SUCCESS') };
    const scannerService: any = {
      scanTokenByAddress: vi.fn().mockResolvedValue({ priceUsd: '1.16' }),
    };
    const autopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({ exit_params: { tp1_percent: 10, tp2_percent: 15 } }),
    };
    const worker: any = createMonitorWorker(tradeRepo, traderService, scannerService,
      autopilotRepo, {}, mockBotApi);
    await worker.processor({ data: { positionId: trade.id, userId: 111, tokenMint: trade.token_mint } });
    expect(traderService.closePosition).not.toHaveBeenCalled();
    scannerService.scanTokenByAddress.mockResolvedValue({ priceUsd: '1.21' });
    await worker.processor({ data: { positionId: trade.id, userId: 111, tokenMint: trade.token_mint } });
    expect(traderService.closePosition).toHaveBeenCalledWith(trade, 1.21, 100);
    expect(autopilotRepo.getOrCreateConfig).not.toHaveBeenCalled();
  });

  it('uses the configured TP1 sell share instead of a hardcoded 50 percent', async () => {
    const trade = {
      id: 'tp1-share', token_mint: 'tokenT', token_symbol: 'TOK', status: 'OPEN', source: 'AUTOPILOT', is_dry_run: true,
      entry_price_usd: 1, sol_amount: 1, highest_pnl_percent: 0,
      exit_policy_snapshot: {
        enabled: true, tp1_percent: 10, tp1_sell_share: 25, tp2_percent: 30,
        sl_percent: 8, trailing_stop_enabled: false,
      },
    };
    const tradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([trade]),
      updateTradeStatus: vi.fn().mockResolvedValue(undefined),
    };
    const traderService: any = { closePosition: vi.fn().mockResolvedValue('UNCERTAIN') };
    const scannerService: any = { scanTokenByAddress: vi.fn().mockResolvedValue({ priceUsd: '1.2' }) };
    const worker: any = createMonitorWorker(
      tradeRepo, traderService, scannerService, {} as any, {} as any, mockBotApi,
    );

    await worker.processor({ data: { positionId: trade.id, userId: 111, tokenMint: trade.token_mint } });
    expect(traderService.closePosition).toHaveBeenCalledWith(trade, 1.2, 25);
  });

  it('uses bounded concurrency so one slow position does not block every monitor job', () => {
    const worker: any = createMonitorWorker(
      {} as any, {} as any, {} as any, {} as any, {} as any, mockBotApi,
    );
    expect(worker.opts.concurrency).toBe(4);
  });

  it('executes a live stop-loss even when the secondary market oracle is unavailable', async () => {
    const trade = {
      id: 'stop-loss-oracle-down', user_id: 111, token_mint: 'tokenSL', token_symbol: 'SL',
      source: 'AUTOPILOT', status: 'OPEN', is_dry_run: false, entry_price_usd: 1,
      token_amount_raw: '1000000', remaining_raw: '1000000', sol_spent_lamports: '1000000000',
      exit_policy_snapshot: { enabled: true, tp1_percent: 15, tp2_percent: 30, sl_percent: 8, trailing_stop_enabled: false },
    };
    const tradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([trade]),
      updateTradeStatus: vi.fn().mockResolvedValue(undefined),
    };
    const traderService: any = { closePosition: vi.fn().mockResolvedValue('UNCERTAIN') };
    const scannerService: any = { scanTokenByAddress: vi.fn().mockResolvedValue(null) };
    const jupiterClient: any = { getQuote: vi.fn().mockResolvedValue({ outAmount: '500000000' }) };
    const worker: any = createMonitorWorker(
      tradeRepo, traderService, scannerService, {} as any, jupiterClient, mockBotApi,
    );

    await worker.processor({ data: { positionId: trade.id, userId: 111, tokenMint: trade.token_mint } });

    expect(scannerService.scanTokenByAddress).not.toHaveBeenCalled();
    expect(traderService.closePosition).toHaveBeenCalledWith(
      trade,
      0.5,
      100,
      expect.objectContaining({ mode: 'EMERGENCY_EXIT', reason: expect.stringContaining('Stop Loss') }),
    );
  });

  it('never applies autopilot exits to a manual position', async () => {
    const trade = {
      id: 'manual-position', user_id: 111, token_mint: 'tokenM', token_symbol: 'MAN',
      source: 'MANUAL', status: 'OPEN', is_dry_run: true, entry_price_usd: 1,
      sol_amount: 1, highest_pnl_percent: 0,
    };
    const tradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([trade]),
      updateTradeStatus: vi.fn(),
    };
    const traderService: any = { closePosition: vi.fn() };
    const scannerService: any = { scanTokenByAddress: vi.fn() };
    const autopilotRepo: any = { getOrCreateConfig: vi.fn() };
    const worker: any = createMonitorWorker(
      tradeRepo, traderService, scannerService, autopilotRepo, {} as any, mockBotApi,
    );

    await worker.processor({ data: { positionId: trade.id, userId: 111, tokenMint: trade.token_mint } });

    expect(autopilotRepo.getOrCreateConfig).not.toHaveBeenCalled();
    expect(scannerService.scanTokenByAddress).not.toHaveBeenCalled();
    expect(traderService.closePosition).not.toHaveBeenCalled();
  });

});
