import { afterEach, describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WalletService } from '../../src/modules/wallet/walletService';
import { KeypairService } from '../../src/modules/wallet/keypairService';
import { getEnv } from '../../src/config/env';

describe('WalletService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('returns the authoritative database wallet when concurrent creation loses the race', async () => {
    const candidate = Keypair.generate();
    const clearSpy = vi.spyOn(KeypairService, 'clearKeypair');
    vi.spyOn(KeypairService, 'createNewKeypair').mockReturnValue(candidate);
    vi.spyOn(KeypairService, 'encrypt').mockReturnValue({
      encryptedData: 'candidate-ciphertext',
      iv: 'candidate-iv',
      authTag: 'candidate-tag',
    });
    const mockRepo: any = {
      getWalletByUserId: vi.fn().mockResolvedValue(null),
      getOrCreateWallet: vi.fn().mockResolvedValue({
        user_id: 12345,
        public_key: '11111111111111111111111111111111',
        encrypted_private_key: 'winner-ciphertext',
        iv: 'winner-iv',
        auth_tag: 'winner-tag',
        encryption_version: 2,
      }),
    };

    const service = new WalletService(mockRepo, {} as any);
    const wallet = await service.getOrCreateWallet(12345);

    expect(wallet.publicKey).toBe('11111111111111111111111111111111');
    expect(wallet.publicKey).not.toBe(candidate.publicKey.toBase58());
    expect(mockRepo.getOrCreateWallet).toHaveBeenCalledTimes(1);
    expect(KeypairService.encrypt).toHaveBeenCalledWith(
      candidate,
      expect.any(String),
      { userId: 12345, publicKey: candidate.publicKey.toBase58() },
    );
    expect(clearSpy).toHaveBeenCalledWith(candidate);
  });

  it('clears a generated candidate when atomic persistence fails', async () => {
    const candidate = Keypair.generate();
    const clearSpy = vi.spyOn(KeypairService, 'clearKeypair');
    vi.spyOn(KeypairService, 'createNewKeypair').mockReturnValue(candidate);
    vi.spyOn(KeypairService, 'encrypt').mockReturnValue({
      encryptedData: 'candidate-ciphertext',
      iv: 'candidate-iv',
      authTag: 'candidate-tag',
    });
    const mockRepo: any = {
      getWalletByUserId: vi.fn().mockResolvedValue(null),
      getOrCreateWallet: vi.fn().mockRejectedValue(new Error('database unavailable')),
    };

    const service = new WalletService(mockRepo, {} as any);
    await expect(service.getOrCreateWallet(12345)).rejects.toThrow('database unavailable');
    expect(clearSpy).toHaveBeenCalledWith(candidate);
  });

  it('upgrades legacy ciphertext to identity-bound version 2 before startup continues', async () => {
    const keypair = Keypair.generate();
    const legacy = KeypairService.encrypt(keypair, getEnv().MASTER_ENCRYPTION_KEY);
    let rebound: any;
    const mockRepo: any = {
      getLegacyWallets: vi.fn().mockResolvedValue([{
        user_id: 12345,
        public_key: keypair.publicKey.toBase58(),
        encrypted_private_key: legacy.encryptedData,
        iv: legacy.iv,
        auth_tag: legacy.authTag,
        encryption_version: 1,
      }]),
      upgradeWalletEncryption: vi.fn().mockImplementation(async (_existing: any, encrypted: any) => {
        rebound = encrypted;
        return true;
      }),
    };

    const service = new WalletService(mockRepo, {} as any);
    await expect(service.upgradeLegacyWalletEncryption()).resolves.toBe(1);

    const reboundKeypair = KeypairService.decrypt(
      {
        encryptedData: rebound.encrypted_private_key,
        iv: rebound.iv,
        authTag: rebound.auth_tag,
      },
      getEnv().MASTER_ENCRYPTION_KEY,
      { userId: 12345, publicKey: keypair.publicKey.toBase58() },
    );
    expect(reboundKeypair.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    KeypairService.clearKeypair(reboundKeypair);
    KeypairService.clearKeypair(keypair);
  });

  it('fails closed when a legacy ciphertext does not match the stored public key', async () => {
    const encryptedKeypair = Keypair.generate();
    const differentPublicKey = Keypair.generate().publicKey.toBase58();
    const legacy = KeypairService.encrypt(encryptedKeypair, getEnv().MASTER_ENCRYPTION_KEY);
    const mockRepo: any = {
      getLegacyWallets: vi.fn().mockResolvedValue([{
        user_id: 12345,
        public_key: differentPublicKey,
        encrypted_private_key: legacy.encryptedData,
        iv: legacy.iv,
        auth_tag: legacy.authTag,
        encryption_version: 1,
      }]),
      upgradeWalletEncryption: vi.fn(),
    };

    const service = new WalletService(mockRepo, {} as any);
    await expect(service.upgradeLegacyWalletEncryption()).rejects.toThrow(
      'Encrypted wallet key does not match its stored public key',
    );
    expect(mockRepo.upgradeWalletEncryption).not.toHaveBeenCalled();
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
