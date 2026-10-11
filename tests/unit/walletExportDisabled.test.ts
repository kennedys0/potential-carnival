import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env', () => ({
  getEnv: () => ({
    PRIVATE_KEY_EXPORT_ENABLED: false,
    MASTER_ENCRYPTION_KEY: 'not-used-while-export-is-disabled',
  }),
}));

import { WalletService } from '../../src/modules/wallet/walletService';

describe('private-key export default-off guard', () => {
  it('rejects before reading or decrypting a wallet', async () => {
    const walletRepo = {
      getWalletByUserId: vi.fn(),
    };
    const service = new WalletService(walletRepo as any, {} as any);

    await expect(service.exportPrivateKey(123)).rejects.toThrow(
      'Export private key dinonaktifkan',
    );
    expect(walletRepo.getWalletByUserId).not.toHaveBeenCalled();
  });
});
