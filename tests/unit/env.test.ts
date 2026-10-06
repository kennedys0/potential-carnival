import { describe, it, expect } from 'vitest';
import { validateEnv } from '../../src/config/env';

describe('Environment Validation', () => {
  it('throws error when required variables are missing', () => {
    expect(() => validateEnv({})).toThrow();
  });

  it('validates complete environment variables successfully', () => {
    const valid = {
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      SOLANA_WSS_URL: 'wss://api.mainnet-beta.solana.com',
      SUPABASE_URL: 'https://xyzcompany.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
      MASTER_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ANTHROPIC_API_KEY: 'sk-ant-api03-dummy',
      REDIS_URL: 'redis://127.0.0.1:6379',
    };
    const parsed = validateEnv(valid);
    expect(parsed.TELEGRAM_BOT_TOKEN).toBe(valid.TELEGRAM_BOT_TOKEN);
    expect(parsed.MASTER_ENCRYPTION_KEY).toHaveLength(64);
  });
});
