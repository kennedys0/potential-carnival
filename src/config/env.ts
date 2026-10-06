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
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().default('https://bandelbanget.xyz/v1'),
  AI_API_KEY: z.string().default('sk-qwen-aa2a54d96046e0b2579a779f76f1dc0c701fb89b18f36068'),
  AI_MODEL: z.string().default('deepseek-v4-flash'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  JITO_TIP_LAMPORTS: z.coerce.number().default(100000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown> = process.env): Env {
  return EnvSchema.parse(raw);
}

// Lazy or defaulted env getter so test imports don't fail without full process.env
let cachedEnv: Env | null = null;
export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = validateEnv(process.env);
  }
  return cachedEnv;
}
