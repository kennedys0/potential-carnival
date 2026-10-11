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
