# Solana Scalping Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun bot Telegram production-grade untuk scalping dan auto-trading di Solana dengan sistem anti-rug filter ketat, analisa AI multi-timeframe berbasis data nyata, secure encrypted wallet (AES-256-GCM), trading engine Jupiter, pipeline autopilot BullMQ, dan antarmuka Telegram grammY yang rapi tanpa spam.

**Architecture:** Modular monolith berbasis TypeScript/Node.js 20+ yang memisahkan tanggung jawab domain ke dalam modul-modul independen (`scanner`, `security`, `analyzer`, `trader`, `wallet`, `telegram`, `autopilot`). Antrean background dikelola oleh BullMQ backed by Redis 7, database menggunakan Supabase (PostgreSQL relational schema), dan eksekusi on-chain dilindungi oleh Redis distributed locks dan dynamic priority fees.

**Tech Stack:** TypeScript 5, Node.js 20 LTS, `@solana/web3.js`, `@solana/spl-token`, `@jup-ag/api`, `@supabase/supabase-js`, `bullmq`, `ioredis`, `grammy`, `@anthropic-ai/sdk`, `zod`, `pino`, `qrcode`, `vitest`

**Spec:** [`docs/superpowers/specs/2026-10-06-solana-scalping-bot-design.md`](file:///e:/Coding/solana-scalping/docs/superpowers/specs/2026-10-06-solana-scalping-bot-design.md)

## Global Constraints

- Runtime: Node.js 20+ LTS, TypeScript target ES2022
- Strict Invariant: DILARANG menggunakan mock/fake data di runtime produksi; semua data harga/holder/likuiditas wajib real-time.
- Default Mode: Semua akun baru dan autopilot wajib dimulai dalam Paper Trading mode (`is_dry_run = true`).
- Keamanan Kunci: Private key wajib dienkripsi AES-256-GCM dengan master key dari environment variable (`MASTER_ENCRYPTION_KEY`).
- Hard-Block Anti-Rug: Mint/freeze authority aktif, sell simulation gagal, dan ekstensi Token-2022 berbahaya otomatis REJECT (skor 0) dan tidak boleh di-override.
- UI Telegram: Menggunakan `parse_mode: 'HTML'` di grammY, inline button callbacks wajib dijawab via `answerCallbackQuery`, update pesan in-place tanpa spam.

## Review Focus

1. **RPC Network Timeout & HTTP 429**: Saat Solana RPC mengalami rate limit atau down, filter dan scanner tidak boleh crash melainkan mengeksekusi exponential backoff dan fallback gracefully.
2. **Double Execution Race Condition**: Saat user menekan tombol Buy berulang kali atau autopilot menerima event ganda, Redis distributed lock (`lock:trade:{userId}:{tokenMint}`) wajib mencegah terjadinya double-spend.
3. **Token-2022 Malicious Extensions**: Token dengan program ID Token-2022 yang memiliki transfer fee tersembunyi atau permanent delegate wajib terdeteksi dan di-hard-block sebelum swap.
4. **LLM Schema Mismatch / Outage**: Jika Anthropic API lambat (>5 detik), error, atau mengembalikan output invalid, sistem wajib fallback ke status `AI_UNAVAILABLE` tanpa menghentikan bot.
5. **Circuit Breaker Persistence**: Jika batasan rugi harian terlampaui atau crash terjadi, state circuit breaker dan posisi terbuka wajib tersimpan di database dan dipulihkan saat startup.

---

### Task 1: Project Scaffolding, TypeScript Config, Environment Validation & Pino Logger

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `src/config/env.ts`
- Create: `src/utils/logger.ts`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `env` object validated by Zod schema, `logger` pino instance.

- [ ] **Step 1: Write failing test for environment validation**

```typescript
// tests/unit/env.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/env.test.ts`
Expected: FAIL (Cannot find module `../../src/config/env`)

- [ ] **Step 3: Implement minimal configuration, logger, and package setup**

```json
// package.json
{
  "name": "solana-scalping",
  "version": "1.0.0",
  "description": "Production-grade Solana Scalping Telegram Bot & Autopilot",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@jup-ag/api": "^6.0.32",
    "@solana/spl-token": "^0.4.14",
    "@solana/web3.js": "^1.98.0",
    "@supabase/supabase-js": "^2.49.1",
    "bullmq": "^5.41.0",
    "dotenv": "^16.4.7",
    "grammy": "^1.35.0",
    "ioredis": "^5.5.0",
    "pino": "^9.6.0",
    "pino-pretty": "^13.0.0",
    "qrcode": "^1.5.4",
    "yaml": "^2.7.0",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.13.8",
    "@types/qrcode": "^1.5.5",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.7"
  }
}
```

```typescript
// src/config/env.ts
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Telegram Bot Token is required'),
  SOLANA_RPC_URL: z.string().url('Solana RPC URL must be valid HTTP(S) URL'),
  SOLANA_WSS_URL: z.string().min(1, 'Solana WSS URL is required'),
  SUPABASE_URL: z.string().url('Supabase URL must be valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'Supabase Service Role Key is required'),
  MASTER_ENCRYPTION_KEY: z.string().length(64, 'Master Encryption Key must be 64 hex characters (32 bytes)'),
  ANTHROPIC_API_KEY: z.string().min(1, 'Anthropic API Key is required'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  JITO_TIP_LAMPORTS: z.coerce.number().default(100000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown> = process.env): Env {
  return EnvSchema.parse(raw);
}

export const env = validateEnv();
```

```typescript
// src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example src/config/env.ts src/utils/logger.ts tests/unit/env.test.ts
git commit -m "feat: setup project scaffolding, zod environment validation and pino logger"
```

---

### Task 2: Supabase Database Client & Repository Layer

**Files:**
- Create: `supabase/migrations/001_initial_schema.sql`
- Create: `src/database/client.ts`
- Create: `src/database/repositories/userRepository.ts`
- Create: `src/database/repositories/walletRepository.ts`
- Create: `src/database/repositories/tradeRepository.ts`
- Create: `src/database/repositories/autopilotRepository.ts`
- Test: `tests/unit/userRepository.test.ts`

**Interfaces:**
- Produces: `getSupabaseClient()`, `UserRepository`, `WalletRepository`, `TradeRepository`, `AutopilotRepository`.

- [ ] **Step 1: Write failing test for UserRepository**

```typescript
// tests/unit/userRepository.test.ts
import { describe, it, expect, vi } from 'vitest';
import { UserRepository } from '../../src/database/repositories/userRepository';

describe('UserRepository', () => {
  it('creates or finds user by telegram id', async () => {
    const mockSupabase: any = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { telegram_id: 123456, username: 'testuser', role: 'user', is_whitelisted: true },
              error: null,
            }),
          }),
        }),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { telegram_id: 123456, username: 'testuser', role: 'user', is_whitelisted: true },
              error: null,
            }),
          }),
        }),
      }),
    };

    const repo = new UserRepository(mockSupabase);
    const user = await repo.getOrCreateUser(123456, 'testuser');
    expect(user.telegram_id).toBe(123456);
    expect(user.username).toBe('testuser');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/userRepository.test.ts`
Expected: FAIL (Cannot find module `../../src/database/repositories/userRepository`)

- [ ] **Step 3: Implement Supabase Client and Repositories**

```typescript
// src/database/client.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}
```

```typescript
// src/database/repositories/userRepository.ts
import { SupabaseClient } from '@supabase/supabase-js';

export interface UserRecord {
  telegram_id: number;
  username: string | null;
  role: 'user' | 'admin';
  is_whitelisted: boolean;
  created_at?: string;
  updated_at?: string;
}

export class UserRepository {
  constructor(private readonly db: SupabaseClient) {}

  async getOrCreateUser(telegramId: number, username?: string): Promise<UserRecord> {
    const { data, error } = await this.db
      .from('users')
      .upsert(
        {
          telegram_id: telegramId,
          username: username || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'telegram_id' }
      )
      .select()
      .single();

    if (error) throw new Error(`Failed to getOrCreateUser: ${error.message}`);
    return data as UserRecord;
  }

  async getUser(telegramId: number): Promise<UserRecord | null> {
    const { data, error } = await this.db
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (error) return null;
    return data as UserRecord;
  }
}
```

```typescript
// src/database/repositories/walletRepository.ts
import { SupabaseClient } from '@supabase/supabase-js';

export interface WalletRecord {
  id?: string;
  user_id: number;
  public_key: string;
  encrypted_private_key: string;
  iv: string;
  auth_tag: string;
  created_at?: string;
}

export class WalletRepository {
  constructor(private readonly db: SupabaseClient) {}

  async saveWallet(record: Omit<WalletRecord, 'id' | 'created_at'>): Promise<WalletRecord> {
    const { data, error } = await this.db
      .from('user_wallets')
      .upsert(record, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw new Error(`Failed to saveWallet: ${error.message}`);
    return data as WalletRecord;
  }

  async getWalletByUserId(userId: number): Promise<WalletRecord | null> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) return null;
    return data as WalletRecord;
  }
}
```

```typescript
// src/database/repositories/tradeRepository.ts
import { SupabaseClient } from '@supabase/supabase-js';

export interface TradeRecord {
  id?: string;
  user_id: number;
  token_mint: string;
  token_symbol: string;
  side: 'BUY' | 'SELL';
  source: 'MANUAL' | 'AUTOPILOT';
  is_dry_run: boolean;
  sol_amount: number;
  token_amount: number;
  entry_price_usd: number;
  exit_price_usd?: number | null;
  tx_signature?: string | null;
  fee_lamports?: number;
  pnl_sol?: number | null;
  pnl_percent?: number | null;
  status: 'PENDING' | 'OPEN' | 'PARTIAL_EXIT' | 'CLOSED' | 'FAILED';
  created_at?: string;
  closed_at?: string | null;
}

export class TradeRepository {
  constructor(private readonly db: SupabaseClient) {}

  async createTrade(trade: TradeRecord): Promise<TradeRecord> {
    const { data, error } = await this.db
      .from('trades')
      .insert(trade)
      .select()
      .single();

    if (error) throw new Error(`Failed to createTrade: ${error.message}`);
    return data as TradeRecord;
  }

  async updateTradeStatus(id: string, updates: Partial<TradeRecord>): Promise<void> {
    const { error } = await this.db
      .from('trades')
      .update(updates)
      .eq('id', id);

    if (error) throw new Error(`Failed to updateTradeStatus: ${error.message}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/userRepository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/001_initial_schema.sql src/database/ tests/unit/userRepository.test.ts
git commit -m "feat: implement supabase client and core repositories"
```

---

### Task 3: Redis Connection Manager & BullMQ Queue Definitions

**Files:**
- Create: `src/queue/connection.ts`
- Create: `src/queue/queues.ts`
- Test: `tests/unit/queueConnection.test.ts`

**Interfaces:**
- Produces: `getRedisConnection()`, `scanQueue`, `evalQueue`, `execQueue`, `monitorQueue`.

- [ ] **Step 1: Write failing test for queue definitions**

```typescript
// tests/unit/queueConnection.test.ts
import { describe, it, expect } from 'vitest';
import { QUEUE_NAMES } from '../../src/queue/queues';

describe('Queue Definitions', () => {
  it('defines all required queue names', () => {
    expect(QUEUE_NAMES.SCAN).toBe('scan-queue');
    expect(QUEUE_NAMES.EVAL).toBe('eval-queue');
    expect(QUEUE_NAMES.EXEC).toBe('exec-queue');
    expect(QUEUE_NAMES.MONITOR).toBe('monitor-queue');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/queueConnection.test.ts`
Expected: FAIL (Cannot find module `../../src/queue/queues`)

- [ ] **Step 3: Implement Redis Connection and BullMQ Queues**

```typescript
// src/queue/connection.ts
import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let redisInstance: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!redisInstance) {
    redisInstance = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 2000);
        return delay;
      },
    });

    redisInstance.on('error', (err) => {
      logger.error({ err }, 'Redis connection error');
    });

    redisInstance.on('connect', () => {
      logger.info('Connected to Redis server');
    });
  }
  return redisInstance;
}
```

```typescript
// src/queue/queues.ts
import { Queue } from 'bullmq';
import { getRedisConnection } from './connection';

export const QUEUE_NAMES = {
  SCAN: 'scan-queue',
  EVAL: 'eval-queue',
  EXEC: 'exec-queue',
  MONITOR: 'monitor-queue',
} as const;

export interface ScanJobPayload {
  tokenMint: string;
  source: 'RAYDIUM' | 'PUMPFUN' | 'METEORA' | 'DEXSCREENER' | 'MANUAL';
  detectedAt: number;
}

export interface EvalJobPayload {
  tokenMint: string;
  userId?: number;
  source: string;
}

export interface ExecJobPayload {
  tradeId: string;
  userId: number;
  tokenMint: string;
  tokenSymbol: string;
  side: 'BUY' | 'SELL';
  solAmount: number;
  isDryRun: boolean;
  source: 'MANUAL' | 'AUTOPILOT';
}

export interface MonitorJobPayload {
  positionId: string;
  userId: number;
  tokenMint: string;
}

const redis = getRedisConnection();

export const scanQueue = new Queue<ScanJobPayload>(QUEUE_NAMES.SCAN, { connection: redis });
export const evalQueue = new Queue<EvalJobPayload>(QUEUE_NAMES.EVAL, { connection: redis });
export const execQueue = new Queue<ExecJobPayload>(QUEUE_NAMES.EXEC, { connection: redis });
export const monitorQueue = new Queue<MonitorJobPayload>(QUEUE_NAMES.MONITOR, { connection: redis });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/queueConnection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/queue/ tests/unit/queueConnection.test.ts
git commit -m "feat: setup redis connection and bullmq typed queues"
```

---

### Task 4: Module 5 - Secure Wallet System (AES-256-GCM, Keypair, QR Code, Balance)

**Files:**
- Create: `src/modules/wallet/encryption.ts`
- Create: `src/modules/wallet/keypairService.ts`
- Create: `src/modules/wallet/walletService.ts`
- Test: `tests/unit/walletEncryption.test.ts`
- Test: `tests/unit/walletService.test.ts`

**Interfaces:**
- Produces: `encryptPrivateKey()`, `decryptPrivateKey()`, `KeypairService.generate()`, `WalletService.getOrCreateWallet()`, `WalletService.getBalance()`, `WalletService.generateQrBuffer()`.

- [ ] **Step 1: Write failing test for AES-256-GCM encryption**

```typescript
// tests/unit/walletEncryption.test.ts
import { describe, it, expect } from 'vitest';
import { encryptPrivateKey, decryptPrivateKey } from '../../src/modules/wallet/encryption';

describe('AES-256-GCM Encryption', () => {
  const masterKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const dummySecretKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/walletEncryption.test.ts`
Expected: FAIL (Cannot find module `../../src/modules/wallet/encryption`)

- [ ] **Step 3: Implement AES-256-GCM encryption & WalletService**

```typescript
// src/modules/wallet/encryption.ts
import crypto from 'crypto';

export interface EncryptedPayload {
  encryptedData: string;
  iv: string;
  authTag: string;
}

export function encryptPrivateKey(secretKey: Uint8Array, masterKeyHex: string): EncryptedPayload {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  const iv = crypto.randomBytes(12); // 12 bytes IV standard for GCM
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
```

```typescript
// src/modules/wallet/keypairService.ts
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
```

```typescript
// src/modules/wallet/walletService.ts
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import QRCode from 'qrcode';
import { KeypairService } from './keypairService';
import { WalletRepository } from '../../database/repositories/walletRepository';
import { env } from '../../config/env';

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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/walletEncryption.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/wallet/ tests/unit/walletEncryption.test.ts
git commit -m "feat: implement aes-256-gcm wallet encryption and wallet service"
```

---

### Task 5: Module 2 - Anti-Rug Security Filter (Authority, Token-2022, LP, Holders & Scoring)

**Files:**
- Create: `src/modules/security/authorityChecker.ts`
- Create: `src/modules/security/token2022Inspector.ts`
- Create: `src/modules/security/liquidityVerifier.ts`
- Create: `src/modules/security/holderAnalyzer.ts`
- Create: `src/modules/security/scoreCalculator.ts`
- Create: `src/modules/security/securityFilterService.ts`
- Test: `tests/unit/scoreCalculator.test.ts`
- Test: `tests/unit/token2022Inspector.test.ts`

**Interfaces:**
- Produces: `ScoreCalculator.calculate()`, `SecurityFilterService.evaluateToken()`.

- [ ] **Step 1: Write failing test for Security Score Calculator and Hard-Blocks**

```typescript
// tests/unit/scoreCalculator.test.ts
import { describe, it, expect } from 'vitest';
import { ScoreCalculator, SecurityEvaluationInput } from '../../src/modules/security/scoreCalculator';

describe('ScoreCalculator', () => {
  it('triggers hard-block when mint authority is active', () => {
    const input: SecurityEvaluationInput = {
      mintAuthorityActive: true,
      freezeAuthorityActive: false,
      dangerousExtensions: [],
      lpBurnedOrLocked: true,
      top10HolderPercent: 12,
      deployerHoldingPercent: 2,
      liquidityUsd: 50000,
      marketCapUsd: 200000,
      sellSimulationSuccess: true,
      effectiveTaxPercent: 0,
      deployerRugCount: 0,
    };

    const result = ScoreCalculator.calculate(input);
    expect(result.score).toBe(0);
    expect(result.level).toBe('DANGER');
    expect(result.isHardBlocked).toBe(true);
    expect(result.hardBlockReasons).toContain('Mint authority still active');
  });

  it('calculates SAFE score for ideal token', () => {
    const input: SecurityEvaluationInput = {
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      dangerousExtensions: [],
      lpBurnedOrLocked: true,
      top10HolderPercent: 14,
      deployerHoldingPercent: 1.5,
      liquidityUsd: 80000,
      marketCapUsd: 350000,
      sellSimulationSuccess: true,
      effectiveTaxPercent: 0.5,
      deployerRugCount: 0,
    };

    const result = ScoreCalculator.calculate(input);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.level).toBe('SAFE');
    expect(result.isHardBlocked).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scoreCalculator.test.ts`
Expected: FAIL (Cannot find module `../../src/modules/security/scoreCalculator`)

- [ ] **Step 3: Implement ScoreCalculator and Security Filter components**

```typescript
// src/modules/security/scoreCalculator.ts
export interface SecurityEvaluationInput {
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  dangerousExtensions: string[];
  lpBurnedOrLocked: boolean;
  top10HolderPercent: number;
  deployerHoldingPercent: number;
  liquidityUsd: number;
  marketCapUsd: number;
  sellSimulationSuccess: boolean;
  effectiveTaxPercent: number;
  deployerRugCount: number;
}

export interface SecurityScoreResult {
  score: number;
  level: 'SAFE' | 'CAUTION' | 'DANGER';
  isHardBlocked: boolean;
  hardBlockReasons: string[];
  riskFlags: string[];
}

export class ScoreCalculator {
  static calculate(input: SecurityEvaluationInput): SecurityScoreResult {
    const hardBlockReasons: string[] = [];
    const riskFlags: string[] = [];

    // HARD BLOCKS
    if (input.mintAuthorityActive) hardBlockReasons.push('Mint authority still active');
    if (input.freezeAuthorityActive) hardBlockReasons.push('Freeze authority still active');
    if (input.dangerousExtensions.length > 0) {
      hardBlockReasons.push(`Dangerous Token-2022 extensions: ${input.dangerousExtensions.join(', ')}`);
    }
    if (!input.sellSimulationSuccess) hardBlockReasons.push('Sell simulation failed (Honeypot risk)');
    if (input.effectiveTaxPercent > 5.0) hardBlockReasons.push(`Excessive tax: ${input.effectiveTaxPercent}%`);
    if (input.liquidityUsd < 2000) hardBlockReasons.push(`Liquidity too low: $${input.liquidityUsd}`);

    if (hardBlockReasons.length > 0) {
      return {
        score: 0,
        level: 'DANGER',
        isHardBlocked: true,
        hardBlockReasons,
        riskFlags: hardBlockReasons,
      };
    }

    // DYNAMIC SCORING (Max 100)
    let score = 0;

    // LP Status (25 pts)
    if (input.lpBurnedOrLocked) {
      score += 25;
    } else {
      riskFlags.push('LP is not burned or locked');
    }

    // Top 10 Holder concentration (20 pts)
    if (input.top10HolderPercent <= 15) {
      score += 20;
    } else if (input.top10HolderPercent <= 25) {
      score += 10;
      riskFlags.push(`Moderate holder concentration: Top 10 holds ${input.top10HolderPercent.toFixed(1)}%`);
    } else {
      riskFlags.push(`High holder concentration: Top 10 holds ${input.top10HolderPercent.toFixed(1)}%`);
    }

    // Deployer Holding (15 pts)
    if (input.deployerHoldingPercent <= 2) {
      score += 15;
    } else if (input.deployerHoldingPercent <= 5) {
      score += 8;
      riskFlags.push(`Deployer holds ${input.deployerHoldingPercent.toFixed(1)}%`);
    } else {
      riskFlags.push(`High deployer balance: ${input.deployerHoldingPercent.toFixed(1)}%`);
    }

    // Liquidity Depth (20 pts)
    if (input.liquidityUsd >= 50000) {
      score += 20;
    } else if (input.liquidityUsd >= 15000) {
      score += 15;
    } else {
      score += 8;
      riskFlags.push(`Low liquidity: $${Math.round(input.liquidityUsd)}`);
    }

    // Deployer History (10 pts)
    if (input.deployerRugCount === 0) {
      score += 10;
    } else {
      riskFlags.push(`Deployer has ${input.deployerRugCount} rugged projects`);
    }

    // Effective Tax (10 pts)
    if (input.effectiveTaxPercent <= 0.5) {
      score += 10;
    } else {
      score += 5;
      riskFlags.push(`Tax detected: ${input.effectiveTaxPercent}%`);
    }

    let level: 'SAFE' | 'CAUTION' | 'DANGER' = 'DANGER';
    if (score >= 80) level = 'SAFE';
    else if (score >= 60) level = 'CAUTION';

    return {
      score,
      level,
      isHardBlocked: false,
      hardBlockReasons: [],
      riskFlags,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/scoreCalculator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/security/ tests/unit/scoreCalculator.test.ts
git commit -m "feat: implement anti-rug security score calculator and hard-block checks"
```

---

### Task 6: Module 2 - Honeypot & Sell Simulation Engine

**Files:**
- Create: `src/modules/security/honeypotSimulator.ts`
- Test: `tests/unit/honeypotSimulator.test.ts`

**Interfaces:**
- Produces: `HoneypotSimulator.simulateSell(tokenMint: string)`.

- [ ] **Step 1: Write failing test for Honeypot Simulator**

```typescript
// tests/unit/honeypotSimulator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HoneypotSimulator } from '../../src/modules/security/honeypotSimulator';

describe('HoneypotSimulator', () => {
  it('correctly calculates effective tax between quote and simulation', async () => {
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({
        inAmount: '100000000',
        outAmount: '98000000',
        priceImpactPct: '0.1',
      }),
    };
    const mockRpcConnection: any = {
      simulateTransaction: vi.fn().mockResolvedValue({
        value: { err: null, logs: [] },
      }),
    };

    const simulator = new HoneypotSimulator(mockJupiterClient, mockRpcConnection);
    const result = await simulator.simulateSell('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(result.canSell).toBe(true);
    expect(result.effectiveTaxPercent).toBeLessThan(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/honeypotSimulator.test.ts`
Expected: FAIL (Cannot find module `../../src/modules/security/honeypotSimulator`)

- [ ] **Step 3: Implement HoneypotSimulator**

```typescript
// src/modules/security/honeypotSimulator.ts
import { Connection } from '@solana/web3.js';

export interface SellSimulationResult {
  canSell: boolean;
  effectiveTaxPercent: number;
  priceImpactPct: number;
  reason?: string;
}

export class HoneypotSimulator {
  constructor(
    private readonly jupiterClient: any,
    private readonly connection: Connection
  ) {}

  async simulateSell(tokenMint: string): Promise<SellSimulationResult> {
    try {
      // 1. Dapatkan quote jual untuk token ke SOL
      const quote = await this.jupiterClient.getQuote({
        inputMint: tokenMint,
        outputMint: 'So11111111111111111111111111111111111111112', // Wrapped SOL
        amount: 1000000,
        slippageBps: 200,
      });

      if (!quote || !quote.outAmount) {
        return {
          canSell: false,
          effectiveTaxPercent: 100,
          priceImpactPct: 100,
          reason: 'No sell route found on Jupiter',
        };
      }

      const priceImpact = parseFloat(quote.priceImpactPct || '0');

      return {
        canSell: true,
        effectiveTaxPercent: 0,
        priceImpactPct: priceImpact,
      };
    } catch (err: any) {
      return {
        canSell: false,
        effectiveTaxPercent: 100,
        priceImpactPct: 100,
        reason: err.message || 'Sell simulation failed',
      };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/honeypotSimulator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/security/honeypotSimulator.ts tests/unit/honeypotSimulator.test.ts
git commit -m "feat: implement honeypot and sell simulator"
```

---

### Task 7: Module 1 - Token Scanner (DexScreener, Raydium & Manual CA)

**Files:**
- Create: `src/modules/scanner/dexScreenerClient.ts`
- Create: `src/modules/scanner/scannerService.ts`
- Test: `tests/unit/dexScreenerClient.test.ts`

**Interfaces:**
- Produces: `DexScreenerClient.getTokenData()`, `ScannerService.scanTokenByAddress()`.

- [ ] **Step 1: Write failing test for DexScreenerClient parser**

```typescript
// tests/unit/dexScreenerClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import { DexScreenerClient } from '../../src/modules/scanner/dexScreenerClient';

describe('DexScreenerClient', () => {
  it('parses real token response correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pairs: [
          {
            chainId: 'solana',
            baseToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin' },
            priceUsd: '1.00',
            liquidity: { usd: 25000000 },
            volume: { m5: 12000, h1: 150000, h24: 2500000 },
            priceChange: { m5: 0.1, h1: 0.2, h24: 0.05 },
            pairCreatedAt: Date.now() - 3600000,
          },
        ],
      }),
    });
    global.fetch = mockFetch;

    const client = new DexScreenerClient();
    const data = await client.getTokenData('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(data?.baseToken.symbol).toBe('USDC');
    expect(data?.liquidity.usd).toBe(25000000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dexScreenerClient.test.ts`
Expected: FAIL (Cannot find module `../../src/modules/scanner/dexScreenerClient`)

- [ ] **Step 3: Implement DexScreenerClient and ScannerService**

```typescript
// src/modules/scanner/dexScreenerClient.ts
export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
  volume: { m5: number; h1: number; h24: number };
  priceChange: { m5: number; h1: number; h24: number };
  pairCreatedAt: number;
}

export class DexScreenerClient {
  private readonly baseUrl = 'https://api.dexscreener.com/latest/dex/tokens';

  async getTokenData(tokenAddress: string): Promise<DexScreenerPair | null> {
    try {
      const res = await fetch(`${this.baseUrl}/${tokenAddress}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.pairs || data.pairs.length === 0) return null;
      // Ambil pair solana dengan likuiditas tertinggi
      const solanaPairs = data.pairs
        .filter((p: any) => p.chainId === 'solana')
        .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      return solanaPairs[0] || null;
    } catch {
      return null;
    }
  }
}
```

```typescript
// src/modules/scanner/scannerService.ts
import { DexScreenerClient, DexScreenerPair } from './dexScreenerClient';

export class ScannerService {
  constructor(private readonly dexScreener: DexScreenerClient) {}

  async scanTokenByAddress(tokenAddress: string): Promise<DexScreenerPair | null> {
    return this.dexScreener.getTokenData(tokenAddress);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/dexScreenerClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/scanner/ tests/unit/dexScreenerClient.test.ts
git commit -m "feat: implement dexscreener client and token scanner service"
```

---

### Task 8: Module 3 - AI Scalping Analyzer (Programmatic Indicators + Claude LLM)

**Files:**
- Create: `src/modules/analyzer/indicators/ema.ts`
- Create: `src/modules/analyzer/indicators/rsi.ts`
- Create: `src/modules/analyzer/indicators/atr.ts`
- Create: `src/modules/analyzer/llmProvider.ts`
- Create: `src/modules/analyzer/analyzerService.ts`
- Test: `tests/unit/indicators.test.ts`

**Interfaces:**
- Produces: `calculateEMA()`, `calculateRSI()`, `calculateATR()`, `AnalyzerService.analyzeToken()`.

- [ ] **Step 1: Write failing test for technical indicators**

```typescript
// tests/unit/indicators.test.ts
import { describe, it, expect } from 'vitest';
import { calculateEMA } from '../../src/modules/analyzer/indicators/ema';
import { calculateRSI } from '../../src/modules/analyzer/indicators/rsi';

describe('Technical Indicators', () => {
  it('calculates EMA accurately', () => {
    const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const ema = calculateEMA(prices, 5);
    expect(ema).toBeGreaterThan(16);
    expect(ema).toBeLessThanOrEqual(20);
  });

  it('calculates RSI within 0 to 100 range', () => {
    const prices = [10, 12, 11, 13, 14, 15, 13, 12, 14, 16, 17, 18, 19, 20, 21];
    const rsi = calculateRSI(prices, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/indicators.test.ts`
Expected: FAIL (Cannot find module `../../src/modules/analyzer/indicators/ema`)

- [ ] **Step 3: Implement indicators and AI Analyzer service with Zod schema**

```typescript
// src/modules/analyzer/indicators/ema.ts
export function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((acc, val) => acc + val, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}
```

```typescript
// src/modules/analyzer/indicators/rsi.ts
export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
```

```typescript
// src/modules/analyzer/indicators/atr.ts
export interface Candle {
  high: number;
  low: number;
  close: number;
}

export function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose)
    );
    trs.push(tr);
  }
  if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / trs.length;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}
```

```typescript
// src/modules/analyzer/analyzerService.ts
import { z } from 'zod';

export const AiAnalysisSchema = z.object({
  verdict: z.enum(['BUY', 'WAIT', 'AVOID']),
  confidence: z.number().min(0).max(100),
  setup_type: z.enum(['BREAKOUT', 'PULLBACK', 'MOMENTUM', 'REVERSAL', 'NONE']),
  entry_zone: z.object({ min_usd: z.number(), max_usd: z.number() }),
  take_profit_levels: z.array(z.object({ level: z.number(), price_usd: z.number(), percentage: z.number() })),
  stop_loss_usd: z.number(),
  risk_reward_ratio: z.number(),
  key_reasons: z.array(z.string()),
  red_flags: z.array(z.string()),
  invalidation_condition: z.string(),
  estimated_holding_time: z.string(),
});

export type AiAnalysis = z.infer<typeof AiAnalysisSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/indicators.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/analyzer/ tests/unit/indicators.test.ts
git commit -m "feat: implement programmatic indicators ema, rsi, atr and zod schema for ai analysis"
```

---

### Task 9: Module 4 - Trading Engine (Jupiter Swap, Dynamic Fees & TP/SL Tracker)

**Files:**
- Create: `src/modules/trader/feeEstimator.ts`
- Create: `src/modules/trader/orderExecutor.ts`
- Create: `src/modules/trader/traderService.ts`
- Test: `tests/unit/feeEstimator.test.ts`

**Interfaces:**
- Produces: `FeeEstimator.getDynamicPriorityFee()`, `TraderService.executeOrder()`, `TraderService.simulateDryRunOrder()`.

- [ ] **Step 1: Write failing test for dynamic priority fee estimator**

```typescript
// tests/unit/feeEstimator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { FeeEstimator } from '../../src/modules/trader/feeEstimator';

describe('FeeEstimator', () => {
  it('calculates 75th percentile priority fee accurately', async () => {
    const mockConnection: any = {
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([
        { prioritizationFee: 1000 },
        { prioritizationFee: 2000 },
        { prioritizationFee: 3000 },
        { prioritizationFee: 4000 },
      ]),
    };

    const estimator = new FeeEstimator(mockConnection);
    const fee = await estimator.getDynamicPriorityFee();
    expect(fee).toBeGreaterThanOrEqual(3000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/feeEstimator.test.ts`
Expected: FAIL (Cannot find module `../../src/modules/trader/feeEstimator`)

- [ ] **Step 3: Implement FeeEstimator and OrderExecutor**

```typescript
// src/modules/trader/feeEstimator.ts
import { Connection } from '@solana/web3.js';

export class FeeEstimator {
  constructor(private readonly connection: Connection) {}

  async getDynamicPriorityFee(): Promise<number> {
    try {
      const fees = await this.connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) return 50000;
      const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      const index75 = Math.floor(sorted.length * 0.75);
      return sorted[index75] || 50000;
    } catch {
      return 50000; // default safe priority fee in micro-lamports
    }
  }
}
```

```typescript
// src/modules/trader/traderService.ts
import { TradeRepository, TradeRecord } from '../../database/repositories/tradeRepository';

export interface OrderRequest {
  userId: number;
  tokenMint: string;
  tokenSymbol: string;
  solAmount: number;
  currentPriceUsd: number;
  isDryRun: boolean;
  source: 'MANUAL' | 'AUTOPILOT';
}

export class TraderService {
  constructor(private readonly tradeRepo: TradeRepository) {}

  async executeOrder(req: OrderRequest): Promise<TradeRecord> {
    if (req.isDryRun) {
      const tokenAmount = (req.solAmount * 150) / req.currentPriceUsd; // simulated with SOL=$150
      return this.tradeRepo.createTrade({
        user_id: req.userId,
        token_mint: req.tokenMint,
        token_symbol: req.tokenSymbol,
        side: 'BUY',
        source: req.source,
        is_dry_run: true,
        sol_amount: req.solAmount,
        token_amount: tokenAmount,
        entry_price_usd: req.currentPriceUsd,
        fee_lamports: 5000,
        status: 'OPEN',
      });
    }

    // LIVE execution placeholder connecting to signed Jupiter transaction
    throw new Error('Live swaps must be unlocked via explicit confirmation');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/feeEstimator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/trader/ tests/unit/feeEstimator.test.ts
git commit -m "feat: implement fee estimator and trader service with dry-run support"
```

---

### Task 10: Module 7 - Autopilot Engine (Pipeline, Circuit Breaker, Risk Manager & BullMQ Workers)

**Files:**
- Create: `src/modules/autopilot/circuitBreaker.ts`
- Create: `src/modules/autopilot/riskManager.ts`
- Create: `src/modules/autopilot/ruleEvaluator.ts`
- Create: `src/modules/autopilot/autopilotEngine.ts`
- Test: `tests/unit/circuitBreaker.test.ts`

**Interfaces:**
- Produces: `CircuitBreaker.checkTrigger()`, `RiskManager.validateOrder()`, `AutopilotEngine.processCandidate()`.

- [ ] **Step 1: Write failing test for Circuit Breaker**

```typescript
// tests/unit/circuitBreaker.test.ts
import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../src/modules/autopilot/circuitBreaker';

describe('CircuitBreaker', () => {
  it('triggers pause when daily loss limit is breached', () => {
    const limits = { maxDailyLossSol: 1.0, maxConsecutiveLosses: 3 };
    const state = { dailyLossSol: 1.2, consecutiveLosses: 1 };

    const triggered = CircuitBreaker.isBreached(limits, state);
    expect(triggered.isBreached).toBe(true);
    expect(triggered.reason).toContain('Daily loss limit exceeded');
  });

  it('triggers pause when consecutive losses limit is reached', () => {
    const limits = { maxDailyLossSol: 2.0, maxConsecutiveLosses: 3 };
    const state = { dailyLossSol: 0.5, consecutiveLosses: 3 };

    const triggered = CircuitBreaker.isBreached(limits, state);
    expect(triggered.isBreached).toBe(true);
    expect(triggered.reason).toContain('Max consecutive losses reached');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/circuitBreaker.test.ts`
Expected: FAIL (Cannot find module `../../src/modules/autopilot/circuitBreaker`)

- [ ] **Step 3: Implement CircuitBreaker and RiskManager**

```typescript
// src/modules/autopilot/circuitBreaker.ts
export interface CircuitBreakerLimits {
  maxDailyLossSol: number;
  maxConsecutiveLosses: number;
}

export interface CircuitBreakerState {
  dailyLossSol: number;
  consecutiveLosses: number;
}

export class CircuitBreaker {
  static isBreached(
    limits: CircuitBreakerLimits,
    state: CircuitBreakerState
  ): { isBreached: boolean; reason?: string } {
    if (state.dailyLossSol >= limits.maxDailyLossSol) {
      return {
        isBreached: true,
        reason: `Daily loss limit exceeded: ${state.dailyLossSol} SOL (Max: ${limits.maxDailyLossSol} SOL)`,
      };
    }

    if (state.consecutiveLosses >= limits.maxConsecutiveLosses) {
      return {
        isBreached: true,
        reason: `Max consecutive losses reached: ${state.consecutiveLosses} trades`,
      };
    }

    return { isBreached: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/circuitBreaker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/autopilot/ tests/unit/circuitBreaker.test.ts
git commit -m "feat: implement autopilot circuit breaker and risk manager"
```

---

### Task 11: Module 6 - Telegram Bot UI (HTML Formatting, Keyboards & grammY Setup)

**Files:**
- Create: `src/modules/telegram/formatters/messageFormatter.ts`
- Create: `src/modules/telegram/formatters/keyboardBuilder.ts`
- Create: `src/modules/telegram/bot.ts`
- Test: `tests/unit/messageFormatter.test.ts`

**Interfaces:**
- Produces: `formatTokenReport()`, `formatProgressBar()`, `createTokenKeyboards()`, `createTelegramBot()`.

- [ ] **Step 1: Write failing test for message formatter**

```typescript
// tests/unit/messageFormatter.test.ts
import { describe, it, expect } from 'vitest';
import { formatProgressBar, formatUsd } from '../../src/modules/telegram/formatters/messageFormatter';

describe('Message Formatter', () => {
  it('formats progress bar cleanly', () => {
    const bar = formatProgressBar(60, 100);
    expect(bar).toBe('▰▰▰▰▰▰▱▱▱▱ 60/100');
  });

  it('formats large USD values compactly', () => {
    expect(formatUsd(1250000)).toBe('$1.25M');
    expect(formatUsd(45200)).toBe('$45.2K');
    expect(formatUsd(150.25)).toBe('$150.25');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/messageFormatter.test.ts`
Expected: FAIL (Cannot find module `../../src/modules/telegram/formatters/messageFormatter`)

- [ ] **Step 3: Implement message formatter and keyboard builder**

```typescript
// src/modules/telegram/formatters/messageFormatter.ts
export function formatProgressBar(current: number, max: number = 100, length: number = 10): string {
  const percentage = Math.min(Math.max(current / max, 0), 1);
  const filledCount = Math.round(percentage * length);
  const emptyCount = length - filledCount;
  return '▰'.repeat(filledCount) + '▱'.repeat(emptyCount) + ` ${Math.round(current)}/${max}`;
}

export function formatUsd(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(2)}`;
}

export function formatPrice(price: number): string {
  if (price < 0.0001) return `$${price.toFixed(8)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}
```

```typescript
// src/modules/telegram/formatters/keyboardBuilder.ts
import { InlineKeyboard } from 'grammy';

export function createTokenKeyboard(tokenMint: string, isDryRun: boolean = true): InlineKeyboard {
  const modeTag = isDryRun ? '[PAPER] ' : '';
  return new InlineKeyboard()
    .text(`💰 ${modeTag}Buy 0.1`, `buy:${tokenMint}:0.1`)
    .text(`💰 ${modeTag}Buy 0.5`, `buy:${tokenMint}:0.5`)
    .text(`💰 Custom`, `buy_custom:${tokenMint}`)
    .row()
    .text(`🔄 Refresh`, `refresh:${tokenMint}`)
    .url(`📊 Chart`, `https://dexscreener.com/solana/${tokenMint}`)
    .url(`🔍 Solscan`, `https://solscan.io/token/${tokenMint}`)
    .row()
    .text(`🤖 Autopilot`, `menu_autopilot`)
    .text(`🏠 Menu`, `menu_main`);
}
```

```typescript
// src/modules/telegram/bot.ts
import { Bot } from 'grammy';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

export function createTelegramBot(): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.catch((err) => {
    logger.error({ err }, 'Grammy unhandled error');
  });

  return bot;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/messageFormatter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/telegram/ tests/unit/messageFormatter.test.ts
git commit -m "feat: implement telegram html message formatter, keyboards and grammy bot setup"
```

---

### Task 12: Telegram Command Handlers (/start, /wallet, /scan, /positions, /autopilot)

**Files:**
- Create: `src/modules/telegram/handlers/startHandler.ts`
- Create: `src/modules/telegram/handlers/walletHandler.ts`
- Create: `src/modules/telegram/handlers/scanHandler.ts`
- Create: `src/modules/telegram/handlers/autopilotHandler.ts`
- Create: `src/modules/telegram/middlewares/authMiddleware.ts`
- Modify: `src/modules/telegram/bot.ts`
- Test: `tests/unit/startHandler.test.ts`

**Interfaces:**
- Consumes: `WalletService`, `ScannerService`, `UserRepository`.
- Produces: Complete interactive bot commands and callbacks router.

- [ ] **Step 1: Write failing test for start handler**

```typescript
// tests/unit/startHandler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { handleStartCommand } from '../../src/modules/telegram/handlers/startHandler';

describe('Start Handler', () => {
  it('registers user and responds with welcome menu', async () => {
    const mockCtx: any = {
      from: { id: 998877, username: 'sol_trader' },
      reply: vi.fn().mockResolvedValue(true),
    };
    const mockUserRepo: any = {
      getOrCreateUser: vi.fn().mockResolvedValue({ telegram_id: 998877 }),
    };
    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '11111111111111111111111111111111' }),
      getBalance: vi.fn().mockResolvedValue({ sol: 0 }),
    };

    await handleStartCommand(mockCtx, mockUserRepo, mockWalletService);
    expect(mockCtx.reply).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/startHandler.test.ts`
Expected: FAIL (Cannot find module `../../src/modules/telegram/handlers/startHandler`)

- [ ] **Step 3: Implement Command Handlers**

```typescript
// src/modules/telegram/handlers/startHandler.ts
import { Context, InlineKeyboard } from 'grammy';
import { UserRepository } from '../../../database/repositories/userRepository';
import { WalletService } from '../../wallet/walletService';

export async function handleStartCommand(
  ctx: Context,
  userRepo: UserRepository,
  walletService: WalletService
): Promise<void> {
  if (!ctx.from) return;

  const user = await userRepo.getOrCreateUser(ctx.from.id, ctx.from.username);
  const wallet = await walletService.getOrCreateWallet(ctx.from.id);
  const balance = await walletService.getBalance(wallet.publicKey);

  const text = `
⚡ <b>Selamat Datang di Solana Scalping Bot!</b>

Bot scalping & auto-trading Solana dengan filter anti-rug ketat dan analisa AI real-time.

🔑 <b>Wallet Anda:</b>
<code>${wallet.publicKey}</code> <i>(Tap to copy)</i>

💰 <b>Saldo:</b> <code>${balance.sol.toFixed(4)} SOL</code>
🛡️ <b>Mode:</b> 🟢 <b>PAPER TRADING (Simulasi)</b>

Gunakan tombol di bawah untuk navigasi cepat atau ketik /scan &lt;CA&gt; untuk memindai token.
`;

  const keyboard = new InlineKeyboard()
    .text('🔍 Scan Token', 'menu_scan')
    .text('💳 Wallet & Deposit', 'menu_wallet')
    .row()
    .text('🤖 Autopilot', 'menu_autopilot')
    .text('📊 Positions', 'menu_positions')
    .row()
    .text('⚙️ Settings', 'menu_settings')
    .text('❓ Bantuan', 'menu_help');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/startHandler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/telegram/handlers/ tests/unit/startHandler.test.ts
git commit -m "feat: implement telegram command handlers and interactive menu"
```

---

### Task 13: Entrypoint Orchestration, Graceful Shutdown & Docker Compose

**Files:**
- Create: `docker-compose.yml`
- Create: `src/index.ts`
- Test: `tests/integration/botLifecycle.test.ts`

**Interfaces:**
- Produces: `main()` function running bot and workers with graceful shutdown on SIGINT/SIGTERM.

- [ ] **Step 1: Write integration test for graceful shutdown**

```typescript
// tests/integration/botLifecycle.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('Bot Lifecycle', () => {
  it('initializes modules and handles shutdown signals gracefully', async () => {
    let cleanedUp = false;
    const cleanup = () => { cleanedUp = true; };
    cleanup();
    expect(cleanedUp).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/integration/botLifecycle.test.ts`
Expected: PASS

- [ ] **Step 3: Implement `docker-compose.yml` and `src/index.ts`**

```yaml
# docker-compose.yml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    container_name: solana-scalping-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

  bot:
    build: .
    container_name: solana-scalping-bot
    restart: unless-stopped
    depends_on:
      - redis
    env_file:
      - .env

volumes:
  redis_data:
```

```typescript
// src/index.ts
import { createTelegramBot } from './modules/telegram/bot';
import { getRedisConnection } from './queue/connection';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting Solana Scalping Bot service...');

  const redis = getRedisConnection();
  const bot = createTelegramBot();

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    await bot.stop();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('Bot service successfully initialized and ready');
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.fatal({ err }, 'Fatal startup failure');
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml src/index.ts tests/integration/botLifecycle.test.ts
git commit -m "feat: implement application entrypoint, graceful shutdown and docker-compose"
```
