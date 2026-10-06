import { Keypair } from '@solana/web3.js';
import { encryptPrivateKey, decryptPrivateKey, EncryptedPayload } from './encryption';

export class KeypairService {
  static createNewKeypair(): Keypair {
    return Keypair.generate();
  }

  static encrypt(keypair: Keypair, masterKeyHex: string): EncryptedPayload {
    return encryptPrivateKey(keypair.secretKey, masterKeyHex);
  }

  static decrypt(payload: EncryptedPayload, masterKeyHex: string): Keypair {
    const secretKey = decryptPrivateKey(payload, masterKeyHex);
    return Keypair.fromSecretKey(secretKey);
  }
}
