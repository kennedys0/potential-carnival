import { Keypair } from '@solana/web3.js';
import {
  encryptPrivateKey,
  decryptPrivateKey,
  EncryptedPayload,
  WalletEncryptionContext,
} from './encryption';

export class KeypairService {
  static createNewKeypair(): Keypair {
    return Keypair.generate();
  }

  static encrypt(
    keypair: Keypair,
    masterKeyHex: string,
    context?: WalletEncryptionContext,
  ): EncryptedPayload {
    return encryptPrivateKey(keypair.secretKey, masterKeyHex, context);
  }

  static decrypt(
    payload: EncryptedPayload,
    masterKeyHex: string,
    context?: WalletEncryptionContext,
  ): Keypair {
    const secretKey = decryptPrivateKey(payload, masterKeyHex, context);
    return Keypair.fromSecretKey(secretKey);
  }

  static clearKeypair(keypair: Keypair): void {
    if (keypair && keypair.secretKey) {
      keypair.secretKey.fill(0);
    }
  }
}
