import { describe, expect, it, vi } from 'vitest';
import { AutopilotRepository } from '../../src/database/repositories/autopilotRepository';

describe('AutopilotRepository safe operational defaults', () => {
  it('does not require unsupported deployer or LP-lock evidence by default', async () => {
    let insertedConfig: any;
    const insertSingle = vi.fn().mockImplementation(async () => ({
      data: insertedConfig,
      error: null,
    }));
    const db: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
          }),
        }),
        insert: vi.fn().mockImplementation((config: any) => {
          insertedConfig = config;
          return {
            select: vi.fn().mockReturnValue({ single: insertSingle }),
          };
        }),
      }),
    };

    const config = await new AutopilotRepository(db).getOrCreateConfig(123);

    expect(config.safety_params).toMatchObject({
      max_top10_percent: 25,
      lp_burn_or_lock_required: false,
    });
    expect(config.safety_params).not.toHaveProperty('max_deployer_percent');
  });
});

describe('AutopilotRepository execution stats', () => {
  it('counts durable submitted trades rather than BUY decision logs', async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const db: any = {
      from: vi.fn((table: string) => {
        const call = { table, filters: [] as Array<[string, unknown]> };
        calls.push(call);
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn((column: string, value: unknown) => {
            call.filters.push([column, value]);
            return builder;
          }),
          in: vi.fn((column: string, value: unknown) => {
            call.filters.push([column, value]);
            return Promise.resolve({ count: 4, error: null });
          }),
          gt: vi.fn((column: string, value: unknown) => {
            call.filters.push([column, value]);
            return Promise.resolve({ count: 2, error: null });
          }),
          single: vi.fn().mockResolvedValue({
            data: {
              daily_realized_pnl_sol: 0.25,
              consecutive_losses: 0,
              is_circuit_broken: false,
              circuit_break_reason: null,
            },
            error: null,
          }),
        };
        return builder;
      }),
    };
    const repo = new AutopilotRepository(db);

    const stats = await repo.getStats(7);

    expect(stats.totalTrades).toBe(4);
    expect(stats.winCount).toBe(2);
    expect(calls.some((call) => call.table === 'decision_logs')).toBe(false);
    const tradeCalls = calls.filter((call) => call.table === 'trades');
    expect(tradeCalls).toHaveLength(2);
    expect(tradeCalls[0].filters).toContainEqual(['source', 'AUTOPILOT']);
    expect(tradeCalls[0].filters).toContainEqual(['side', 'BUY']);
    expect(tradeCalls[0].filters).toContainEqual([
      'status',
      ['BROADCAST_ATTEMPTED', 'PENDING', 'OPEN', 'PARTIAL_EXIT', 'CLOSED'],
    ]);
  });
});
