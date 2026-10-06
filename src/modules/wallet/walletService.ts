import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import QRCode from 'qrcode';
import bs58 from 'bs58';
import { KeypairService } from './keypairService';
import { WalletRepository } from '../../database/repositories/walletRepository';
import { getEnv } from '../../config/env';

export class WalletService {
  constructor(
    private readonly walletRepo: WalletRepository,
    private readonly connection: Connection
  ) {}

  async getOrCreateWallet(userId: number): Promise<{ publicKey: string }> {
    const existing = await this.walletRepo.getWalletByUserId(userId);
    if (existing) {
      return { publicKey: existing.public_key };
    }

    const keypair = KeypairService.createNewKeypair();
    const env = getEnv();
    const encrypted = KeypairService.encrypt(keypair, env.MASTER_ENCRYPTION_KEY);

    await this.walletRepo.saveWallet({
      user_id: userId,
      public_key: keypair.publicKey.toBase58(),
      encrypted_private_key: encrypted.encryptedData,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
    });

    return { publicKey: keypair.publicKey.toBase58() };
  }

  async getBalance(publicKeyString: string): Promise<{ sol: number; lamports: number }> {
    const pubkey = new PublicKey(publicKeyString);
    const lamports = await this.connection.getBalance(pubkey);
    return {
      sol: lamports / LAMPORTS_PER_SOL,
      lamports,
    };
  }

  async generateQrBuffer(address: string): Promise<Buffer> {
    return QRCode.toBuffer(address, {
      type: 'png',
      width: 300,
      margin: 2,
    });
  }

  async exportPrivateKey(userId: number): Promise<string> {
    const wallet = await this.walletRepo.getWalletByUserId(userId);
    if (!wallet) throw new Error('Wallet belum terdaftar. Ketik /start terlebih dahulu.');
    const env = getEnv();
    const keypair = KeypairService.decrypt(
      {
        encryptedData: wallet.encrypted_private_key,
        iv: wallet.iv,
        authTag: wallet.auth_tag,
      },
      env.MASTER_ENCRYPTION_KEY
    );
    return bs58.encode(keypair.secretKey);
  }
}
