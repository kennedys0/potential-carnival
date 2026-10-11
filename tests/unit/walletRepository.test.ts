import { describe, expect, it, vi } from 'vitest';
import { WalletRepository } from '../../src/database/repositories/walletRepository';

describe('WalletRepository custody invariants', () => {
  it('returns null only when the wallet row is genuinely absent', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const db: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ maybeSingle }),
        }),
      }),
    };

    const repo = new WalletRepository(db);
    await expect(repo.getWalletByUserId(12345)).resolves.toBeNull();
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a transient wallet read error', async () => {
    const db: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'connection reset' },
            }),
          }),
        }),
      }),
    };

    const repo = new WalletRepository(db);
    await expect(repo.getWalletByUserId(12345)).rejects.toThrow(
      'Failed to getWalletByUserId: connection reset',
    );
  });

  it('uses the insert-only wallet RPC and returns its authoritative row', async () => {
    const winner = {
      user_id: 12345,
      public_key: '11111111111111111111111111111111',
      encrypted_private_key: 'winner-ciphertext',
      iv: 'winner-iv',
      auth_tag: 'winner-tag',
    };
    const single = vi.fn().mockResolvedValue({ data: winner, error: null });
    const rpc = vi.fn().mockReturnValue({ single });
    const repo = new WalletRepository({ rpc } as any);

    await expect(repo.getOrCreateWallet({
      user_id: 12345,
      public_key: 'So11111111111111111111111111111111111111112',
      encrypted_private_key: 'candidate-ciphertext',
      iv: 'candidate-iv',
      auth_tag: 'candidate-tag',
    })).resolves.toEqual(winner);

    expect(rpc).toHaveBeenCalledWith('get_or_create_user_wallet', {
      p_user_id: 12345,
      p_public_key: 'So11111111111111111111111111111111111111112',
      p_encrypted_private_key: 'candidate-ciphertext',
      p_iv: 'candidate-iv',
      p_auth_tag: 'candidate-tag',
    });
  });
});
