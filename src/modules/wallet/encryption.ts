import crypto from 'crypto';

export interface EncryptedPayload {
  encryptedData: string;
  iv: string;
  authTag: string;
}

export interface WalletEncryptionContext {
  userId: number;
  publicKey: string;
}

function walletAssociatedData(context: WalletEncryptionContext): Buffer {
  if (!Number.isSafeInteger(context.userId) || context.userId <= 0 || !context.publicKey) {
    throw new Error('Invalid wallet encryption context');
  }
  return Buffer.from(
    `solana-scalping-wallet:v2\nuser_id:${context.userId}\npublic_key:${context.publicKey}`,
    'utf8',
  );
}

export function encryptPrivateKey(
  secretKey: Uint8Array,
  masterKeyHex: string,
  context?: WalletEncryptionContext,
): EncryptedPayload {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  if (context) cipher.setAAD(walletAssociatedData(context));

  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedData: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

export function decryptPrivateKey(
  payload: EncryptedPayload,
  masterKeyHex: string,
  context?: WalletEncryptionContext,
): Uint8Array {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);

  if (context) decipher.setAAD(walletAssociatedData(context));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.encryptedData, 'hex')),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}
