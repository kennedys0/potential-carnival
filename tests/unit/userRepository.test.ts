import { describe, it, expect, vi } from 'vitest';
import { UserRepository } from '../../src/database/repositories/userRepository';

describe('UserRepository', () => {
  it('creates or finds user by telegram id', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { telegram_id: 123456, username: 'testuser', role: 'user', is_whitelisted: true },
              error: null,
            }),
          }),
        }),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { telegram_id: 123456, username: 'testuser', role: 'user', is_whitelisted: true },
              error: null,
            }),
          }),
        }),
      }),
    };

    const repo = new UserRepository(mockSupabase);
    const user = await repo.getOrCreateUser(123456, 'testuser');
    expect(user.telegram_id).toBe(123456);
    expect(user.username).toBe('testuser');
  });
});
