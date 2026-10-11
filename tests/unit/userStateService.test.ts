import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateMaxDrawdownPercent,
  UserStateService,
} from '../../src/modules/user/userStateService';

const redis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/queue/connection', () => ({ getRedisConnection: () => redis }));

describe('UserStateService circuit-breaker accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
  });

  it('calculates peak-to-trough realized drawdown in event order', () => {
    expect(calculateMaxDrawdownPercent(1, [
      { realized_pnl_sol: 0.2 },
      { realized_pnl_sol: -0.1 },
      { realized_pnl_sol: -0.2 },
      { realized_pnl_sol: 0.05 },
    ])).toBeCloseTo(25, 8);
  });

  it('persists current daily metrics and drawdown instead of reusing a stale value', async () => {
    const tradeRepo = {
      getTradesByStatuses: vi.fn().mockResolvedValue([]),
      getDailyRealizedPnlEvents: vi.fn().mockResolvedValue([
        { trade_id: 'a', realized_pnl_sol: 0.1, occurred_at: '2026-10-11T01:00:00Z' },
        { trade_id: 'b', realized_pnl_sol: -0.2, occurred_at: '2026-10-11T02:00:00Z' },
      ]),
      getRecentClosedTrades: vi.fn().mockResolvedValue([{ pnl_sol: -0.2 }]),
    };
    const autopilotRepo = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        sizing_params: { autopilot_budget_sol: 1, min_reserve_sol: 0 },
      }),
      getAutopilotState: vi.fn().mockResolvedValue({
        is_circuit_broken: false,
        max_drawdown: 99,
      }),
      updateAutopilotState: vi.fn().mockResolvedValue(undefined),
    };
    const walletService = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: 'wallet' }),
      getBalance: vi.fn().mockResolvedValue({ sol: 0.9 }),
    };
    const service = new UserStateService(tradeRepo as any, autopilotRepo as any, walletService as any);

    const state = await service.getAutopilotState(7);

    expect(state.maxDrawdown).toBeCloseTo(18.181818, 5);
    expect(state.dailyLossSol).toBeCloseTo(0.2);
    expect(autopilotRepo.updateAutopilotState).toHaveBeenCalledWith(7, expect.objectContaining({
      daily_realized_pnl_sol: -0.1,
      daily_trades_count: 2,
      consecutive_losses: 1,
      max_drawdown: state.maxDrawdown,
    }));
  });

  it('clears a persisted breaker when current metrics no longer breach a limit', async () => {
    const autopilotRepo = {
      getOrCreateConfig: vi.fn().mockResolvedValue({ circuit_breaker_params: {} }),
      updateAutopilotState: vi.fn().mockResolvedValue(undefined),
      saveCircuitBreakerEvent: vi.fn(),
    };
    const service = new UserStateService({} as any, autopilotRepo as any, {} as any);

    await expect(service.checkCircuitBreaker(7, {
      openPositionsCount: 0,
      sniperPositionsCount: 0,
      trendingPositionsCount: 0,
      availableBalanceSol: 1,
      dailyLossSol: 0,
      consecutiveLosses: 0,
      maxDrawdown: 0,
      isCircuitBroken: true,
      circuitBreakReason: 'old daily loss',
      heldMints: [],
    })).resolves.toBe(false);

    expect(redis.del).toHaveBeenCalledWith('killswitch:user:7');
    expect(autopilotRepo.updateAutopilotState).toHaveBeenCalledWith(7, {
      is_circuit_broken: false,
      circuit_break_reason: null,
    });
    expect(autopilotRepo.saveCircuitBreakerEvent).not.toHaveBeenCalled();
  });

  it('does not duplicate an event while the same breaker remains active', async () => {
    const reason = 'Daily loss limit reached: 1.00 SOL >= 1';
    const autopilotRepo = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        circuit_breaker_params: { max_daily_loss_sol: 1 },
      }),
      updateAutopilotState: vi.fn(),
      saveCircuitBreakerEvent: vi.fn(),
    };
    const service = new UserStateService({} as any, autopilotRepo as any, {} as any);

    await expect(service.checkCircuitBreaker(7, {
      openPositionsCount: 0,
      sniperPositionsCount: 0,
      trendingPositionsCount: 0,
      availableBalanceSol: 1,
      dailyLossSol: 1,
      consecutiveLosses: 0,
      maxDrawdown: 0,
      isCircuitBroken: true,
      circuitBreakReason: reason,
      heldMints: [],
    })).resolves.toBe(true);

    expect(redis.set).toHaveBeenCalled();
    expect(autopilotRepo.updateAutopilotState).not.toHaveBeenCalled();
    expect(autopilotRepo.saveCircuitBreakerEvent).not.toHaveBeenCalled();
  });
});
