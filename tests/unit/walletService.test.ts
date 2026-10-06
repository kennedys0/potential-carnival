import { describe, it, expect, vi } from 'vitest';
import { WalletService } from '../../src/modules/wallet/walletService';

describe('WalletService', () => {
  it('returns existing wallet if already registered', async () => {
    const mockRepo: any = {
      getWalletByUserId: vi.fn().mockResolvedValue({
        user_id: 12345,
        public_key: '6V7Cq111111111111111111111111111111111111111',
      }),
    };
    const mockConnection: any = {
      getBalance: vi.fn().mockResolvedValue(1000000000), // 1 SOL
    };

    const service = new WalletService(mockRepo, mockConnection);
    const wallet = await service.getOrCreateWallet(12345);
    expect(wallet.publicKey).toBe('6V7Cq111111111111111111111111111111111111111');
  });

  it('generates QR buffer for an address', async () => {
    const mockRepo: any = {};
    const mockConnection: any = {};
    const service = new WalletService(mockRepo, mockConnection);
    const qrBuffer = await service.generateQrBuffer('6V7Cq111111111111111111111111111111111111111');
    expect(Buffer.isBuffer(qrBuffer)).toBe(true);
    expect(qrBuffer.length).toBeGreaterThan(0);
  });
});
