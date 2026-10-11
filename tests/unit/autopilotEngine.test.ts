import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutopilotEngine } from '../../src/modules/autopilot/autopilotEngine';
import * as queueConnection from '../../src/queue/connection';

describe('AutopilotEngine', () => {
  let mockAutopilotRepo: any;
  let mockTraderService: any;
  let mockRedis: any;
  let mockSniperRepo: any;
  let mockReservations: any;

  beforeEach(() => {
    mockAutopilotRepo = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        is_active: true,
        mode: 'PAPER',
        safety_params: {},
        ai_params: {},
        sizing_params: { mode: 'FIXED_SOL', fixed_sol: 0.1 },
        circuit_breaker_params: { max_daily_loss_sol: 1.0, max_consecutive_losses: 3 },
      }),
      saveDecisionLog: vi.fn().mockResolvedValue(undefined),
    };

    mockTraderService = {
      executeOrder: vi.fn().mockResolvedValue({}),
      tradeRepo: {
        acquireBuyLock: vi.fn().mockResolvedValue(true),
        releaseBuyLock: vi.fn().mockResolvedValue(true),
        getTradesByStatuses: vi.fn().mockResolvedValue([]),
      }
    };

    mockSniperRepo = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        enabled: false, trading_mode: 'PAPER', buy_amount_sol: 0.01,
        max_active_positions: 3, max_buys_per_day: 3, max_daily_entry_budget_sol: 0.03,
      }),
    };
    mockReservations = {
      reserve: vi.fn().mockResolvedValue('reservation-1'),
      finish: vi.fn().mockResolvedValue(undefined),
      releaseIfUnbroadcast: vi.fn().mockResolvedValue(true),
    };
    mockRedis = {
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };

    vi.spyOn(queueConnection, 'getRedisConnection').mockReturnValue(mockRedis);
  });

  it('rejects if circuit breaker is active (daily loss >= limit)', async () => {
    const engine = new AutopilotEngine(mockAutopilotRepo, mockTraderService, mockSniperRepo, mockReservations);
    
    const currentState = {
      openPositionsCount: 0,
      availableBalanceSol: 10,
      dailyLossSol: 1.5, // >= 1.0
      consecutiveLosses: 0,
    };

    const result = await engine.processCandidate(
      1, 'MINT', 'TKN', 1, 100000, 
      { score: 100, riskFlags: [] }, null, currentState
    );

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('Circuit breaker active');
    expect(mockTraderService.executeOrder).not.toHaveBeenCalled();
    expect(mockAutopilotRepo.saveDecisionLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'REJECT' }));
  });

  it('rejects if token is already held', async () => {
    const engine = new AutopilotEngine(mockAutopilotRepo, mockTraderService, mockSniperRepo, mockReservations);
    
    const currentState = {
      openPositionsCount: 0,
      availableBalanceSol: 10,
      dailyLossSol: 0,
      consecutiveLosses: 0,
      heldMints: ['MINT'], // already holds
    };

    const result = await engine.processCandidate(
      1, 'MINT', 'TKN', 1, 100000, 
      { score: 100, riskFlags: [] }, null, currentState
    );

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('Already holding this token');
    expect(mockTraderService.executeOrder).not.toHaveBeenCalled();
    expect(mockAutopilotRepo.saveDecisionLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'SKIP' }));
  });

  it('rejects if database lock cannot be acquired', async () => {
    mockTraderService.tradeRepo.acquireBuyLock.mockResolvedValue(false); // lock failed
    const engine = new AutopilotEngine(mockAutopilotRepo, mockTraderService, mockSniperRepo, mockReservations);
    
    const currentState = {
      openPositionsCount: 0,
      availableBalanceSol: 10,
      dailyLossSol: 0,
      consecutiveLosses: 0,
    };

    const result = await engine.processCandidate(
      1, 'MINT', 'TKN', 1, 100000, 
      { score: 100, riskFlags: [] }, null, currentState
    );

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('Lock acquired by another process');
    expect(mockTraderService.executeOrder).not.toHaveBeenCalled();
  });

  it('rejects if max positions reached', async () => {
    mockAutopilotRepo.getOrCreateConfig.mockResolvedValue({
      is_active: true,
      mode: 'PAPER',
      safety_params: {},
      ai_params: {},
      sizing_params: { max_concurrent_positions: 2 },
      circuit_breaker_params: {},
    });
    const engine = new AutopilotEngine(mockAutopilotRepo, mockTraderService, mockSniperRepo, mockReservations);
    
    const currentState = {
      openPositionsCount: 2, // limit is 2
      availableBalanceSol: 10,
      dailyLossSol: 0,
      consecutiveLosses: 0,
    };

    const result = await engine.processCandidate(
      1, 'MINT', 'TKN', 1, 100000, 
      { score: 100, level: 'SAFE', riskFlags: [] } as any, 
      { verdict: 'BUY', confidence: 90, setup_type: 'BREAKOUT', stop_loss_usd: 0.9, risk_reward_ratio: 2 } as any, 
      currentState
    );

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('Max concurrent positions limit reached');
    expect(mockTraderService.executeOrder).not.toHaveBeenCalled();
  });

  it('executes if all checks pass', async () => {
    const engine = new AutopilotEngine(mockAutopilotRepo, mockTraderService, mockSniperRepo, mockReservations);
    
    const currentState = {
      openPositionsCount: 0,
      availableBalanceSol: 10,
      dailyLossSol: 0,
      consecutiveLosses: 0,
    };

    const result = await engine.processCandidate(
      1, 'MINT', 'TKN', 1, 100000, 
      { score: 100, level: 'SAFE', riskFlags: [] } as any, 
      { verdict: 'BUY', confidence: 90, setup_type: 'BREAKOUT', stop_loss_usd: 0.9, risk_reward_ratio: 2 } as any, 
      currentState
    );

    expect(result.executed).toBe(true);
    expect(mockTraderService.executeOrder).toHaveBeenCalled();
    expect(mockAutopilotRepo.saveDecisionLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'BUY' }));
  });

  it('fails closed when configured LP and ownership limits cannot be verified', async () => {
    mockAutopilotRepo.getOrCreateConfig.mockResolvedValue({
      is_active: true,
      mode: 'PAPER',
      safety_params: {
        lp_burn_or_lock_required: true,
        max_top10_percent: 25,
        max_deployer_percent: 5,
      },
      ai_params: {},
      sizing_params: { mode: 'FIXED_SOL', fixed_sol: 0.1 },
      circuit_breaker_params: {},
    });
    const engine = new AutopilotEngine(mockAutopilotRepo, mockTraderService, mockSniperRepo, mockReservations);

    const result = await engine.processCandidate(
      1, 'MINT', 'TKN', 1, 100000,
      {
        score: 100,
        level: 'SAFE',
        isHardBlocked: false,
        hardBlockReasons: [],
        riskFlags: [],
        coverage: 100,
        report: [],
        criticalChecks: {
          dangerousExtensions: [],
          lpBurnedOrLocked: null,
          top10HolderPercent: 10,
          deployerHoldingPercent: null,
        },
      },
      { verdict: 'BUY', confidence: 90, setup_type: 'BREAKOUT', stop_loss_usd: 0.9, risk_reward_ratio: 2 } as any,
      {
        openPositionsCount: 0,
        availableBalanceSol: 10,
        dailyLossSol: 0,
        consecutiveLosses: 0,
      },
    );

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('LP burn/lock status is unavailable');
    expect(result.reason).toContain('Deployer holding is unavailable');
    expect(mockTraderService.executeOrder).not.toHaveBeenCalled();
  });
});
