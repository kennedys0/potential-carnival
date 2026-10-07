import { describe, it, expect } from 'vitest';
import { validateEnv } from '../../src/config/env';

describe('Environment Validation', () => {
  it('throws error when required variables are missing', () => {
    expect(() => validateEnv({ NODE_ENV: 'test' })).toThrow();
  });

  it('validates complete environment variables successfully', () => {
    const valid = {
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      SOLANA_WSS_URL: 'wss://api.mainnet-beta.solana.com',
      SUPABASE_URL: 'https://xyzcompany.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
      MASTER_ENCRYPTION_KEY: 'e1a49f7b3c2d8e6f1a5b9d3c4e7f8a2b5d6e9f1a2b3c4d5e6f7a8b9c0d1e2f3a',
      REDIS_URL: 'redis://127.0.0.1:6379',
    };
    const parsed = validateEnv(valid);
    expect(parsed.TELEGRAM_BOT_TOKEN).toBe(valid.TELEGRAM_BOT_TOKEN);
    expect(parsed.MASTER_ENCRYPTION_KEY).toHaveLength(64);
  });

  describe('LIVE_TRADING_ENABLED (flag pengaman live trading)', () => {
    const base = {
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      SOLANA_WSS_URL: 'wss://api.mainnet-beta.solana.com',
      SUPABASE_URL: 'https://xyzcompany.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
      MASTER_ENCRYPTION_KEY: 'e1a49f7b3c2d8e6f1a5b9d3c4e7f8a2b5d6e9f1a2b3c4d5e6f7a8b9c0d1e2f3a',
      REDIS_URL: 'redis://127.0.0.1:6379',
    };

    it('default MATI saat tidak diisi', () => {
      expect(validateEnv({ ...base }).LIVE_TRADING_ENABLED).toBe(false);
    });

    it("string 'false' berarti MATI (bukan hidup)", () => {
      expect(validateEnv({ ...base, LIVE_TRADING_ENABLED: 'false' }).LIVE_TRADING_ENABLED).toBe(false);
    });

    it("string 'true' berarti hidup", () => {
      expect(validateEnv({ ...base, LIVE_TRADING_ENABLED: 'true' }).LIVE_TRADING_ENABLED).toBe(true);
    });

    it.each(['0', 'no', 'FALSE', 'True', 'abc', '1'])("nilai ambigu '%s' membuat startup GAGAL (bukan diam-diam hidup)", (v) => {
      expect(() => validateEnv({ ...base, LIVE_TRADING_ENABLED: v })).toThrow();
    });
  });
});
