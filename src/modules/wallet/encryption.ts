import crypto from 'crypto';

export interface EncryptedPayload {
  encryptedData: string;
  iv: string;
  authTag: string;
}

export function encryptPrivateKey(secretKey: Uint8Array, masterKeyHex: string): EncryptedPayload {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);

  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedData: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

export function decryptPrivateKey(payload: EncryptedPayload, masterKeyHex: string): Uint8Array {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);

  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.encryptedData, 'hex')),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}
