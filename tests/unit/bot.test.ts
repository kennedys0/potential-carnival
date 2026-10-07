import { describe, it, expect, vi } from 'vitest';
import { createTelegramBot } from '../../src/modules/telegram/bot';

describe('Telegram Bot Whitelist', () => {
  it('blocks access if whitelist is empty', async () => {
    vi.stubEnv('WHITELISTED_USERS', '');
    const bot = createTelegramBot('dummy_token');
    
    let nextCalled = false;
    const ctx = { from: { id: 12345 } } as any;
    
    const mw = (bot as any).middleware();
    
    // To kill the redundant mutation, mock includes so !includes is false.
    // If 'whitelistedUsers.length === 0' is removed, it will evaluate to false and allow access.
    const originalIncludes = Array.prototype.includes;
    Array.prototype.includes = vi.fn().mockReturnValue(true) as any;
    
    await mw(ctx, async () => { nextCalled = true; });
    
    Array.prototype.includes = originalIncludes;
    
    expect(nextCalled).toBe(false);
  });
});
