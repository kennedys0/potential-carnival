import crypto from 'node:crypto';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env', () => ({
  getEnv: () => ({ PRIVATE_KEY_EXPORT_ENABLED: true }),
}));

import {
  handleWalletExportExecute,
  handleWalletExportPrompt,
  verifyWalletExportSignature,
} from '../../src/modules/telegram/handlers/walletHandler';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateContext() {
  return {
    from: { id: 123 },
    chat: { id: 123, type: 'private' },
    reply: vi.fn().mockResolvedValue({ message_id: 77 }),
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  } as any;
}

function signMessage(keypair: Keypair, message: string): string {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(keypair.secretKey.subarray(0, 32))]),
    format: 'der',
    type: 'pkcs8',
  });
  return bs58.encode(crypto.sign(null, Buffer.from(message, 'utf8'), privateKey));
}

function exportFixture() {
  const owner = Keypair.generate();
  const wallet = Keypair.generate();
  const challenge = {
    version: 1,
    userId: 123,
    ownerPubkey: owner.publicKey.toBase58(),
    walletPublicKey: wallet.publicKey.toBase58(),
    expiresAt: Date.now() + 120_000,
    message: [
      'Solana Scalping Bot - Wallet Export Authorization',
      'Telegram user: 123',
      `Bot wallet: ${wallet.publicKey.toBase58()}`,
      'Nonce: 0123456789abcdef',
      `Expires at: ${new Date(Date.now() + 120_000).toISOString()}`,
    ].join('\n'),
  };
  const walletRecord = {
    user_id: 123,
    public_key: challenge.walletPublicKey,
    owner_pubkey: challenge.ownerPubkey,
  };
  return {
    owner,
    challenge,
    walletRecord,
    signature: signMessage(owner, challenge.message),
  };
}

describe('private-key export security', () => {
  it('verifies an Ed25519 owner-wallet signature and rejects a different signer', () => {
    const fixture = exportFixture();
    expect(verifyWalletExportSignature(
      fixture.challenge.ownerPubkey,
      fixture.challenge.message,
      fixture.signature,
    )).toBe(true);
    expect(verifyWalletExportSignature(
      fixture.challenge.ownerPubkey,
      fixture.challenge.message,
      signMessage(Keypair.generate(), fixture.challenge.message),
    )).toBe(false);
  });

  it('issues a short-lived challenge bound to the current owner and bot wallet', async () => {
    const fixture = exportFixture();
    const ctx = privateContext();
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const walletService = {
      getWalletRecord: vi.fn().mockResolvedValue(fixture.walletRecord),
    };

    await handleWalletExportPrompt(ctx, walletService as any, redis);

    expect(redis.set).toHaveBeenCalledWith(
      'wallet_export_challenge:123',
      expect.any(String),
      'EX',
      120,
    );
    const stored = JSON.parse(redis.set.mock.calls[0][1]);
    expect(stored).toMatchObject({
      version: 1,
      userId: 123,
      ownerPubkey: fixture.challenge.ownerPubkey,
      walletPublicKey: fixture.challenge.walletPublicKey,
    });
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('/export_key &lt;SIGNATURE_BASE58&gt;'),
      expect.any(Object),
    );
  });

  it('consumes a valid signed challenge and persists a deletion job', async () => {
    const fixture = exportFixture();
    const ctx = privateContext();
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue(JSON.stringify(fixture.challenge)),
    };
    const walletService = {
      getWalletRecord: vi.fn().mockResolvedValue(fixture.walletRecord),
      exportPrivateKey: vi.fn().mockResolvedValue('SECRET_BASE58'),
    };
    const deleteQueue = { add: vi.fn().mockResolvedValue({ id: 'job' }) };

    await handleWalletExportExecute(
      ctx,
      walletService as any,
      redis,
      deleteQueue,
      fixture.signature,
    );

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringMatching(/redis\.call\('del'/),
      1,
      'wallet_export_challenge:123',
    );
    expect(walletService.exportPrivateKey).toHaveBeenCalledWith(123);
    expect(deleteQueue.add).toHaveBeenCalledWith(
      'delete-secure-message',
      { chatId: 123, messageId: 77 },
      expect.objectContaining({ delay: 60_000, attempts: 10 }),
    );
  });

  it('does not reveal the key for a signature from a different wallet', async () => {
    const fixture = exportFixture();
    const ctx = privateContext();
    const walletService = {
      getWalletRecord: vi.fn().mockResolvedValue(fixture.walletRecord),
      exportPrivateKey: vi.fn(),
    };

    await handleWalletExportExecute(
      ctx,
      walletService as any,
      {
        get: vi.fn().mockResolvedValue(null),
        eval: vi.fn().mockResolvedValue(JSON.stringify(fixture.challenge)),
      },
      { add: vi.fn() },
      signMessage(Keypair.generate(), fixture.challenge.message),
    );

    expect(walletService.exportPrivateKey).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Signature withdrawal-owner wallet tidak valid'),
      expect.any(Object),
    );
  });

  it('deletes the key message immediately if durable scheduling fails', async () => {
    const fixture = exportFixture();
    const ctx = privateContext();
    const walletService = {
      getWalletRecord: vi.fn().mockResolvedValue(fixture.walletRecord),
      exportPrivateKey: vi.fn().mockResolvedValue('SECRET_BASE58'),
    };

    await handleWalletExportExecute(
      ctx,
      walletService as any,
      {
        get: vi.fn().mockResolvedValue(null),
        eval: vi.fn().mockResolvedValue(JSON.stringify(fixture.challenge)),
      },
      { add: vi.fn().mockRejectedValue(new Error('redis unavailable')) },
      fixture.signature,
    );

    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(123, 77);
    expect(ctx.reply).toHaveBeenLastCalledWith(
      expect.stringContaining('langsung dihapus'),
      expect.any(Object),
    );
  });

  it('warns explicitly if both scheduling and immediate deletion fail', async () => {
    const fixture = exportFixture();
    const ctx = privateContext();
    ctx.api.deleteMessage.mockRejectedValue(new Error('telegram unavailable'));

    await handleWalletExportExecute(
      ctx,
      {
        getWalletRecord: vi.fn().mockResolvedValue(fixture.walletRecord),
        exportPrivateKey: vi.fn().mockResolvedValue('SECRET_BASE58'),
      } as any,
      {
        get: vi.fn().mockResolvedValue(null),
        eval: vi.fn().mockResolvedValue(JSON.stringify(fixture.challenge)),
      },
      { add: vi.fn().mockRejectedValue(new Error('redis unavailable')) },
      fixture.signature,
    );

    expect(ctx.reply).toHaveBeenLastCalledWith(
      expect.stringContaining('Hapus pesan private key secara manual sekarang'),
      expect.any(Object),
    );
  });
});
