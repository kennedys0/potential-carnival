import { z } from 'zod';

export const AppSettingsSchema = z.object({
  MOCK_SOL_PRICE_USD: z.number().default(150),
  PAPER_TRADE_FEE_LAMPORTS: z.number().default(50000),
  DEFAULT_SLIPPAGE_BPS: z.number().default(50),
  DAY_BOUNDARY_TZ: z.string().default('UTC'),
  FALLBACK_AI_MODEL: z.string().default('claude-3-5-haiku-20241022'),
  RISK_MULTIPLIER_STOP_LOSS: z.number().default(1.5),
  RISK_MULTIPLIER_TP1: z.number().default(1.5),
  RISK_MULTIPLIER_TP2: z.number().default(3.0),
  MAX_LOSS_PERCENTAGE: z.number().default(0.9), // 10% max loss fallback
  ANALYZER_PARAMS: z.object({
    MIN_CANDLES: z.number().default(21),
    MAX_STALE_CANDLE_AGE_MS: z.number().default(300000), // 5 minutes
  }).default({}),
  SECURITY_PARAMS: z.object({
    MIN_LIQUIDITY_USD: z.number().default(2000),
    MAX_TAX_PERCENT: z.number().default(5.0),
    MIN_COVERAGE_PERCENT: z.number().default(60), // min coverage required
    WEIGHTS: z.object({
      LP_STATUS: z.number().default(25),
      TOP10_HOLDER: z.number().default(20),
      DEPLOYER_HOLDING: z.number().default(15),
      LIQUIDITY_DEPTH: z.number().default(20),
      DEPLOYER_HISTORY: z.number().default(10),
      EFFECTIVE_TAX: z.number().default(10),
    }).default({}),
    THRESHOLDS: z.object({
      TOP10_SAFE: z.number().default(15),
      TOP10_CAUTION: z.number().default(25),
      DEPLOYER_SAFE: z.number().default(2),
      DEPLOYER_CAUTION: z.number().default(5),
      LIQUIDITY_SAFE: z.number().default(50000),
      LIQUIDITY_CAUTION: z.number().default(15000),
      TAX_SAFE: z.number().default(0.5),
    }).default({}),
  }).default({}),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const appSettings: AppSettings = AppSettingsSchema.parse({});
