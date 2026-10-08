import { z } from 'zod';
import dotenv from 'dotenv';
import { logger } from '../utils/logger';
dotenv.config();

const hex64Regex = /^[0-9a-f]{64}$/i;
const isLowEntropy = (key: string) => {
  if (key === '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef') return true;
  // Check for repeated patterns (e.g. all 0s, all 'a's, or 'abcdabcd')
  if (/^([0-9a-f])\1+$/i.test(key)) return true;
  const uniqueChars = new Set(key).size;
  if (uniqueChars < 8) return true;
  return false;
};

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Telegram Bot Token is required'),
  SOLANA_RPC_URL: z.string().url('Solana RPC URL must be valid HTTP(S) URL'),
  SOLANA_RPC_FALLBACK_URL: z.string().url().optional(),
  SECURE_WITHDRAWAL_RPC_URL: z.string().url().optional(),
  SOLANA_WSS_URL: z.string().min(1, 'Solana WSS URL is required'),
  SOLANA_WSS_FALLBACK_URL: z.string().optional(),
  SUPABASE_URL: z.string().url('Supabase URL must be valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'Supabase Service Role Key is required'),
  MASTER_ENCRYPTION_KEY: z.string()
    .length(64, 'Master Encryption Key must be 64 hex characters (32 bytes)')
    .regex(hex64Regex, 'Master Encryption Key must be valid hex string')
    .refine((val) => !isLowEntropy(val), { message: 'Master Encryption Key has low entropy, uses sample value, or repeating pattern' }),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  JITO_TIP_LAMPORTS: z.coerce.number().default(100000),
  WHITELISTED_USERS: z.string().default(''), // comma-separated user IDs
  ADMIN_USER_IDS: z.string().default(''), // comma-separated user IDs for admin roles
  LIVE_TRADING_ENABLED: z
    .enum(['true', 'false'], { errorMap: () => ({ message: 'LIVE_TRADING_ENABLED must be exactly "true" or "false"' }) })
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown> = process.env): Env {
  try {
    return EnvSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error({ errors: error.errors }, '❌ Environment validation failed');
    }
    if (raw.NODE_ENV === 'test' || process.env.NODE_ENV === 'test') throw error;
    process.exit(1);
  }
}

// Lazy or defaulted env getter so test imports don't fail without full process.env
let cachedEnv: Env | null = null;
export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = validateEnv(process.env);
  }
  return cachedEnv;
}
