import { Connection } from '@solana/web3.js';
import { getEnv } from './config/env';
import { logger } from './utils/logger';
import { createFallbackFetch } from './utils/rpcFallback';
import { getSupabaseClient } from './database/client';
import { UserRepository } from './database/repositories/userRepository';
import { WalletRepository } from './database/repositories/walletRepository';
import { TradeRepository } from './database/repositories/tradeRepository';
import { AutopilotRepository } from './database/repositories/autopilotRepository';
import { getRedisConnection } from './queue/connection';
import { createQueues } from './queue/queues';
import { createMonitorWorker } from './queue/workers/monitorWorker';
import { createReconcileWorker } from './queue/workers/reconcileWorker';
import { WalletService } from './modules/wallet/walletService';
import { ScannerService } from './modules/scanner/scannerService';
import { DexScreenerClient } from './modules/scanner/dexScreenerClient';
import { GeckoTerminalClient } from './modules/scanner/geckoTerminalClient';
import { SecurityFilterService } from './modules/security/securityFilterService';
import { AnalyzerService } from './modules/analyzer/analyzerService';
import { OpenAiCompatibleProvider } from './modules/analyzer/llmProvider';
import { TraderService } from './modules/trader/traderService';
import { JupiterClient } from './modules/trader/jupiterClient';
import { AutopilotEngine } from './modules/autopilot/autopilotEngine';
import { createTelegramBot } from './modules/telegram/bot';
import { registerBotRoutes } from './modules/telegram/router';
import { TrendScanner } from './modules/scanner/trendScanner';
import { UserStateService } from './modules/user/userStateService';

async function main() {
  logger.info('Initializing Solana Scalping Bot services...');

  const env = getEnv();
  
  if (env.LIVE_TRADING_ENABLED) {
    logger.warn('⚠️ WARNING: LIVE TRADING IS ENABLED ⚠️');
  } else {
    logger.info('🛡️ System is running in PAPER TRADING ONLY mode.');
  }

  const solanaConnection = new Connection(env.SOLANA_RPC_URL, {
    commitment: 'confirmed',
    wsEndpoint: env.SOLANA_WSS_URL,
    fetch: createFallbackFetch(env.SOLANA_RPC_URL, env.SOLANA_RPC_FALLBACK_URL),
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
  const geckoTerminalClient = new GeckoTerminalClient();

  const jupiterClient = new JupiterClient(solanaConnection);
  const securityService = new SecurityFilterService(solanaConnection, jupiterClient);
  const llmProvider = env.AI_BASE_URL && env.AI_API_KEY ? new OpenAiCompatibleProvider({
    baseUrl: env.AI_BASE_URL,
    apiKey: env.AI_API_KEY,
    model: env.AI_MODEL || 'deepseek-v4-flash',
    timeoutMs: 60000,
  }) : undefined;
  const analyzerService = new AnalyzerService(llmProvider);
  const traderService = new TraderService(tradeRepo, walletService, jupiterClient);
  const autopilotEngine = new AutopilotEngine(autopilotRepo, traderService);

  // BullMQ Queues & Redis
  const redis = getRedisConnection();
  const queues = createQueues();

  const scannerService = new ScannerService(dexScreenerClient, geckoTerminalClient, redis);
  const userStateService = new UserStateService(tradeRepo, autopilotRepo, walletService);
  
  const bot = createTelegramBot();

  const trendScanner = new TrendScanner(
    scannerService,
    autopilotEngine,
    securityService,
    analyzerService,
    autopilotRepo,
    userStateService,
    bot.api
  );

  // BullMQ Workers
  const monitorWorker = createMonitorWorker(tradeRepo, traderService, scannerService, autopilotRepo, jupiterClient, bot.api);
  const reconcileWorker = createReconcileWorker(tradeRepo, walletService);

  // Position Monitoring Scheduler (runs every minute)
  if (process.env.NODE_ENV !== 'test') {
    setInterval(async () => {
      try {
        const { data: openTrades, error } = await supabase.from('trades').select('*').in('status', ['OPEN', 'PARTIAL_EXIT']);
        if (!error && openTrades) {
          for (const trade of openTrades) {
            await queues.monitorQueue.add('monitor-position', {
              positionId: trade.id,
              userId: trade.user_id,
              tokenMint: trade.token_mint,
            });
          }
        }
      } catch (err) {
        logger.error({ err }, 'Error in position monitoring scheduler');
      }
    }, 60000);

    // Start Autopilot Trend Scanner
    trendScanner.start();

    // Schedule Reconciliation Job (every 5 minutes)
    queues.reconcileQueue.add('reconcile-job', undefined, {
      repeat: { pattern: '*/5 * * * *' }
    });
  }

  // Telegram Bot routes

  registerBotRoutes(bot, {
    userRepo,
    autopilotRepo,
    walletService,
    scannerService,
    securityService,
    analyzerService,
    tradeRepo,
    traderService,
  });

  // Start Bot Polling (in development or non-test mode)
  if (process.env.NODE_ENV !== 'test') {
    bot.start({
      onStart: (botInfo) => {
        logger.info({ username: botInfo.username }, 'Telegram Bot successfully started and listening');
      },
    });

    // Start Deposit Monitoring
    walletService.startDepositMonitoring(async (userId, amountSol, signature) => {
      let text = `🟢 <b>Deposit Berhasil Diterima!</b>\n\n💰 <b>Jumlah:</b> <code>${amountSol.toFixed(4)} SOL</code>`;
      if (signature) {
        text += `\n🔍 <a href="https://solscan.io/tx/${signature}">Lihat di Solscan</a>`;
      }
      try {
        await bot.api.sendMessage(userId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      } catch (err) {
        logger.error({ err, userId }, 'Gagal mengirim notifikasi deposit');
      }
    }).catch(err => {
      logger.error({ err }, 'Gagal memulai deposit monitoring');
    });
  }

  // Graceful Shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);
    try {
      await bot.stop();
      trendScanner.stop();
      await monitorWorker.close();
      await reconcileWorker.close();
      await queues.scanQueue.close();
      await queues.evalQueue.close();
      await queues.execQueue.close();
      await queues.monitorQueue.close();
      await queues.reconcileQueue.close();
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
