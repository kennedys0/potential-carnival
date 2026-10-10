import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyTradeTracker } from '../../src/modules/copytrade/copyTradeTracker';
import { currencyService } from '../../src/utils/currencyService';

const redis = { set: vi.fn(), get: vi.fn(), eval: vi.fn() };
vi.mock('../../src/queue/connection', () => ({ getRedisConnection: () => redis }));

vi.mock('../../src/utils/currencyService', () => ({
  currencyService: {
    fetchRates: vi.fn().mockResolvedValue(undefined),
    getUsdPerSol: vi.fn().mockReturnValue(200),
  },
}));

describe('CopyTradeTracker risk controls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('converts max_buy_usd with a fresh rate and reserves exposure before execution', async () => {
    const trader: any = {
      acquireBuyLock: vi.fn().mockResolvedValue(true),
      releaseBuyLock: vi.fn().mockResolvedValue(undefined),
      hasActiveTrade: vi.fn().mockResolvedValue(false),
      executeOrder: vi.fn().mockResolvedValue({ status: 'OPEN' }),
    };
    const reservation: any = {
      reserve: vi.fn().mockResolvedValue('reservation-1'),
      finish: vi.fn().mockResolvedValue(undefined),
      releaseIfUnbroadcast: vi.fn(),
    };
    const autopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        mode: 'PAPER',
        safety_params: { min_safety_score: 70, allowed_levels: ['SAFE'], min_liquidity_usd: 5_000 },
        sizing_params: { mode: 'FIXED_SOL', fixed_sol: 0.1, max_concurrent_positions: 3, min_reserve_sol: 0.01 },
        exit_params: { tp1_percent: 15, sl_percent: 8 },
      }),
    };
    const stateService: any = {
      getAutopilotState: vi.fn().mockResolvedValue({
        openPositionsCount: 0, availableBalanceSol: 1, heldMints: [], isCircuitBroken: false,
      }),
      checkCircuitBreaker: vi.fn().mockResolvedValue(false),
    };
    const botApi = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const tracker = new CopyTradeTracker(
      {} as any, {} as any, trader, {} as any, {} as any,
      autopilotRepo, reservation, stateService, botApi,
    );

    await (tracker as any).executeFollower(
      { user_id: 7, max_buy_usd: 10 },
      'TokenMint111111111111111111111111111111111',
      'TOK',
      1,
      50_000,
      { score: 90, level: 'SAFE' },
      'source-signature',
    );

    expect(currencyService.getUsdPerSol).toHaveBeenCalled();
    expect(reservation.reserve).toHaveBeenCalledWith(expect.objectContaining({
      strategy: 'COPY_TRADE',
      amountSol: 0.05,
    }));
    expect(trader.executeOrder).toHaveBeenCalledWith(expect.objectContaining({
      solAmount: 0.05,
      strategy: 'COPY_TRADE',
      source: 'AUTOPILOT',
    }));
    expect(reservation.finish).toHaveBeenCalledWith('reservation-1', 'COMPLETED');
  });

  it('rejects an already-held mint before reservation or execution', async () => {
    const trader: any = { executeOrder: vi.fn() };
    const reservation: any = { reserve: vi.fn() };
    const tracker = new CopyTradeTracker(
      {} as any, {} as any, trader, {} as any, {} as any,
      { getOrCreateConfig: vi.fn().mockResolvedValue({ safety_params: {}, sizing_params: {}, exit_params: {} }) } as any,
      reservation,
      {
        getAutopilotState: vi.fn().mockResolvedValue({ heldMints: ['MINT'], openPositionsCount: 1, availableBalanceSol: 1 }),
        checkCircuitBreaker: vi.fn().mockResolvedValue(false),
      } as any,
      { sendMessage: vi.fn() },
    );

    await expect((tracker as any).executeFollower(
      { user_id: 7, max_buy_usd: 10 }, 'MINT', 'TOK', 1, 50_000,
      { score: 100, level: 'SAFE' }, 'source-signature',
    )).rejects.toThrow(/already held/);
    expect(reservation.reserve).not.toHaveBeenCalled();
    expect(trader.executeOrder).not.toHaveBeenCalled();
  });
});
