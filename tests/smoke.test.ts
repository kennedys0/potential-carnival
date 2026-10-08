import { describe, it, expect, vi } from 'vitest';

// Mock database client, telegram bot, and web3 to avoid actual connections
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(),
        in: vi.fn(),
        not: vi.fn(),
        order: vi.fn(),
        single: vi.fn()
      }))
    }))
  }))
}));

vi.mock('grammy', () => {
  return {
    Bot: class {
      api = {
        sendMessage: vi.fn(),
        setMyCommands: vi.fn(),
      };
      command = vi.fn();
      callbackQuery = vi.fn();
      on = vi.fn();
      start = vi.fn();
      stop = vi.fn();
      use = vi.fn();
    },
    InlineKeyboard: class {
      text() { return this; }
      url() { return this; }
      row() { return this; }
    }
  };
});

describe('Smoke Test', () => {
  it('should successfully import index without crashing (verifies all imports in the tree)', async () => {
    // We just dynamically import the index file to ensure no "Cannot find module" errors
    const index = await import('../src/index');
    expect(index).toBeDefined();
  }, 45000);
});
