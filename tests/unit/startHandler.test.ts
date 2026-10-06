import { describe, it, expect, vi } from 'vitest';
import { handleStartCommand } from '../../src/modules/telegram/handlers/startHandler';

describe('Start Handler', () => {
  it('registers user and responds with welcome menu', async () => {
    const mockCtx: any = {
      from: { id: 998877, username: 'sol_trader' },
      reply: vi.fn().mockResolvedValue(true),
    };
    const mockUserRepo: any = {
      getOrCreateUser: vi.fn().mockResolvedValue({ telegram_id: 998877 }),
    };
    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '11111111111111111111111111111111' }),
      getBalance: vi.fn().mockResolvedValue({ sol: 0 }),
    };

    await handleStartCommand(mockCtx, mockUserRepo, mockWalletService);
    expect(mockCtx.reply).toHaveBeenCalled();
  });
});
