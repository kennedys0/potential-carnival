import { Connection } from '@solana/web3.js';
import { getEnv } from './config/env';
import { logger } from './utils/logger';
import { getSupabaseClient } from './database/client';
import { UserRepository } from './database/repositories/userRepository';
import { WalletRepository } from './database/repositories/walletRepository';
import { TradeRepository } from './database/repositories/tradeRepository';
import { AutopilotRepository } from './database/repositories/autopilotRepository';
import { getRedisConnection } from './queue/connection';
import { createQueues } from './queue/queues';
import { WalletService } from './modules/wallet/walletService';
import { ScannerService } from './modules/scanner/scannerService';
import { DexScreenerClient } from './modules/scanner/dexScreenerClient';
import { SecurityFilterService } from './modules/security/securityFilterService';
import { AnalyzerService } from './modules/analyzer/analyzerService';
import { OpenAiCompatibleProvider } from './modules/analyzer/llmProvider';
import { TraderService } from './modules/trader/traderService';
import { AutopilotEngine } from './modules/autopilot/autopilotEngine';
import { createTelegramBot } from './modules/telegram/bot';
import { registerBotRoutes } from './modules/telegram/router';

async function main() {
  logger.info('Initializing Solana Scalping Bot services...');

  const env = getEnv();
  const solanaConnection = new Connection(env.SOLANA_RPC_URL, {
    commitment: 'confirmed',
    wsEndpoint: env.SOLANA_WSS_URL,
  });

  // Repositories
  const supabase = getSupabaseClient();
  const userRepo = new UserRepository(supabase);
  const walletRepo = new WalletRepository(supabase);
  const tradeRepo = new TradeRepository(supabase);
  const autopilotRepo = new AutopilotRepository(supabase);

  // Core Services
  const walletService = new WalletService(walletRepo, solanaConnection);
  const dexScreenerClient = new DexScreenerClient();
  const scannerService = new ScannerService(dexScreenerClient);
  const securityService = new SecurityFilterService(solanaConnection);
  const llmProvider = new OpenAiCompatibleProvider({
    baseUrl: env.AI_BASE_URL,
    apiKey: env.AI_API_KEY,
    model: env.AI_MODEL,
  });
  const analyzerService = new AnalyzerService(llmProvider);
  const traderService = new TraderService(tradeRepo);
  const autopilotEngine = new AutopilotEngine(autopilotRepo, traderService);

  // BullMQ Queues & Redis
  const redis = getRedisConnection();
  const queues = createQueues();

  // Telegram Bot
  const bot = createTelegramBot();
  registerBotRoutes(bot, {
    userRepo,
    autopilotRepo,
    walletService,
    scannerService,
    securityService,
    analyzerService,
  });

  // Start Bot Polling (in development or non-test mode)
  if (process.env.NODE_ENV !== 'test') {
    bot.start({
      onStart: (botInfo) => {
        logger.info({ username: botInfo.username }, 'Telegram Bot successfully started and listening');
      },
    });
  }

  // Graceful Shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);
    try {
      await bot.stop();
      await queues.scanQueue.close();
      await queues.evalQueue.close();
      await queues.execQueue.close();
      await queues.monitorQueue.close();
      await redis.quit();
      logger.info('Graceful shutdown completed successfully');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('All modules successfully registered and active');
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.fatal({ err }, 'Fatal startup failure');
    process.exit(1);
  });
}
