import { describe, it, expect } from 'vitest';
import { encryptPrivateKey, decryptPrivateKey } from '../../src/modules/wallet/encryption';

describe('AES-256-GCM Encryption', () => {
  const masterKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const dummySecretKey = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32
  ]);

  it('encrypts and decrypts secret key accurately', () => {
    const encrypted = encryptPrivateKey(dummySecretKey, masterKeyHex);
    expect(encrypted.encryptedData).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.authTag).toBeDefined();

    const decrypted = decryptPrivateKey(encrypted, masterKeyHex);
    expect(decrypted).toEqual(dummySecretKey);
  });

  it('fails decryption with wrong authTag or tampered data', () => {
    const encrypted = encryptPrivateKey(dummySecretKey, masterKeyHex);
    const tampered = { ...encrypted, authTag: '00'.repeat(16) };
    expect(() => decryptPrivateKey(tampered, masterKeyHex)).toThrow();
  });
});
