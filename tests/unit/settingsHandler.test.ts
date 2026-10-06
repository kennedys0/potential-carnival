import { describe, it, expect, vi } from 'vitest';
import { handleSettingsMenu } from '../../src/modules/telegram/handlers/settingsHandler';

describe('Settings Handler', () => {
  it('renders settings dashboard with trading parameters', async () => {
    const mockCtx: any = {
      from: { id: 123456 },
      reply: vi.fn().mockResolvedValue(true),
    };

    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        user_id: 123456,
        is_active: true,
        mode: 'PAPER',
        risk_profile: 'MODERATE',
        sizing_params: { fixed_sol: 0.1 },
        safety_params: { min_safety_score: 75 },
      }),
    };

    await handleSettingsMenu(mockCtx, mockAutopilotRepo);

    expect(mockCtx.reply).toHaveBeenCalled();
    const messageText = mockCtx.reply.mock.calls[0][0];
    expect(messageText).toContain('Pengaturan Scalping & Trading Bot');
    expect(messageText).toContain('PAPER TRADING');
  });

  it('updates existing message if called from callbackQuery', async () => {
    const mockCtx: any = {
      from: { id: 123456 },
      callbackQuery: { data: 'menu_settings' },
      editMessageText: vi.fn().mockResolvedValue(true),
    };

    const mockAutopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        user_id: 123456,
        is_active: false,
        mode: 'LIVE',
        risk_profile: 'AGGRESSIVE',
        sizing_params: { fixed_sol: 0.25 },
        safety_params: { min_safety_score: 60 },
      }),
    };

    await handleSettingsMenu(mockCtx, mockAutopilotRepo);

    expect(mockCtx.editMessageText).toHaveBeenCalled();
    const messageText = mockCtx.editMessageText.mock.calls[0][0];
    expect(messageText).toContain('LIVE ON-CHAIN');
  });
});
