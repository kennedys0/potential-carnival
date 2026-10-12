import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRadarHub } from '../../src/modules/telegram/handlers/radarHandler';
import { liveFeedSubscribers } from '../../src/modules/scanner/liveFeedState';

describe('Radar Handler', () => {
  beforeEach(() => {
    liveFeedSubscribers.clear();
  });

  it('renders radar hub with inactive live feed', async () => {
    const mockCtx: any = {
      from: { id: 98765 },
      reply: vi.fn().mockResolvedValue(true),
    };

    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        is_active: true,
        sizing_params: { fixed_sol: 0.15 },
      }),
    };

    const mockSniperRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        enabled: false,
        buy_amount_sol: 0.05,
      }),
    };

    await handleRadarHub(mockCtx, mockAutopilotRepo, mockSniperRepo);

    expect(mockCtx.reply).toHaveBeenCalled();
    const sentText = mockCtx.reply.mock.calls[0][0];
    expect(sentText).toContain('RADAR LIVE FEED COMMAND HUB');
    expect(sentText).toContain('🔕 NONAKTIF');
    expect(sentText).toContain('0.15 SOL');
  });

  it('updates radar hub message when live feed is active', async () => {
    liveFeedSubscribers.add(98765);

    const mockCtx: any = {
      from: { id: 98765 },
      callbackQuery: { data: 'radar_refresh' },
      editMessageText: vi.fn().mockResolvedValue(true),
    };

    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        is_active: false,
        sizing_params: {},
      }),
    };

    const mockSniperRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        enabled: true,
        buy_amount_sol: 0.2,
      }),
    };

    await handleRadarHub(mockCtx, mockAutopilotRepo, mockSniperRepo);

    expect(mockCtx.editMessageText).toHaveBeenCalled();
    const sentText = mockCtx.editMessageText.mock.calls[0][0];
    expect(sentText).toContain('🟢 AKTIF');
    expect(sentText).toContain('0.2 SOL');
  });
});
