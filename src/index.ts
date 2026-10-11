import { Connection } from '@solana/web3.js';
import { getEnv } from './config/env';
import { logger } from './utils/logger';
import { createFallbackFetch } from './utils/rpcFallback';
import { getSupabaseClient } from './database/client';
import { UserRepository } from './database/repositories/userRepository';
import { WalletRepository } from './database/repositories/walletRepository';
import { TradeRepository } from './database/repositories/tradeRepository';
import { AutopilotRepository } from './database/repositories/autopilotRepository';
import { SniperRepository } from './database/repositories/sniperRepository';
import { StrategyReservationRepository } from './database/repositories/strategyReservationRepository';
import { CopyTradeRepository } from './database/repositories/copyTradeRepository';
import { getRedisConnection } from './queue/connection';
import { createQueues } from './queue/queues';
import { createMonitorWorker } from './queue/workers/monitorWorker';
import { createReconcileWorker } from './queue/workers/reconcileWorker';
import { createSecureMessageDeleteWorker } from './queue/workers/secureMessageDeleteWorker';
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
import { SniperScanner } from './modules/scanner/sniperScanner';
import { CopyTradeTracker } from './modules/copytrade/copyTradeTracker';
import { UserStateService } from './modules/user/userStateService';
import { liveFeedSubscribers } from './modules/scanner/liveFeedState';

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
  const sniperRepo = new SniperRepository(supabase);
  const strategyReservations = new StrategyReservationRepository(supabase);
  const copyTradeRepo = new CopyTradeRepository(supabase);

  // Core Services
  const walletService = new WalletService(walletRepo, solanaConnection);
  const upgradedWallets = await walletService.upgradeLegacyWalletEncryption();
  if (upgradedWallets > 0) {
    logger.info({ upgradedWallets }, 'Upgraded legacy wallet ciphertexts to identity-bound encryption');
  }
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

  const scanLlmProvider = env.SCAN_AI_BASE_URL && env.SCAN_AI_API_KEY ? new OpenAiCompatibleProvider({
    baseUrl: env.SCAN_AI_BASE_URL,
    apiKey: env.SCAN_AI_API_KEY,
    model: env.SCAN_AI_MODEL || 'deepseek-v4-flash',
    timeoutMs: 60000,
  }) : undefined;
  const scanAnalyzerService = scanLlmProvider ? new AnalyzerService(scanLlmProvider) : analyzerService;
  const traderService = new TraderService(tradeRepo, walletService, jupiterClient, undefined, strategyReservations);
  const autopilotEngine = new AutopilotEngine(autopilotRepo, traderService, sniperRepo, strategyReservations);

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

  const sniperScanner = new SniperScanner(
    scannerService,
    autopilotEngine,
    securityService,
    analyzerService,
    sniperRepo,
    userStateService,
    bot.api
  );

  const copyTradeTracker = new CopyTradeTracker(
    solanaConnection,
    copyTradeRepo,
    traderService,
    scannerService,
    securityService,
    autopilotRepo,
    strategyReservations,
    userStateService,
    bot.api
  );

  // BullMQ Workers
  const monitorWorker = createMonitorWorker(tradeRepo, traderService, scannerService, autopilotRepo, jupiterClient, bot.api, sniperRepo);
  const reconcileWorker = createReconcileWorker(tradeRepo, walletService, strategyReservations);
  const secureMessageDeleteWorker = createSecureMessageDeleteWorker(bot.api);

  // Position Monitoring Scheduler (runs every minute)
  if (process.env.NODE_ENV !== 'test') {
    setInterval(async () => {
      try {
        const { data: openTrades, error } = await supabase
          .from('trades')
          .select('*')
          .eq('source', 'AUTOPILOT')
          .in('status', ['OPEN', 'PARTIAL_EXIT']);
        if (!error && openTrades) {
          for (const trade of openTrades) {
            await queues.monitorQueue.add('monitor-position', {
              positionId: trade.id,
              userId: trade.user_id,
              tokenMint: trade.token_mint,
            }, {
              jobId: `monitor-${trade.id}`,
              removeOnComplete: true,
              removeOnFail: 100,
            });
          }
        }
      } catch (err) {
        logger.error({ err }, 'Error in position monitoring scheduler');
      }
    }, 60000);

    // Start Autopilot Trend Scanner
    trendScanner.start();
    sniperScanner.start();
    copyTradeTracker.start();

    // Schedule Reconciliation Job (every 5 minutes)
    queues.reconcileQueue.add('reconcile-job', undefined, {
      jobId: 'reconcile-global',
      repeat: { pattern: '*/5 * * * *' },
      removeOnComplete: true,
      removeOnFail: 100,
    });

    // Auto-subscribe all active autopilot users to live feed on startup
    const activeConfigs = await autopilotRepo.getAllActiveConfigs();
    activeConfigs.forEach(c => liveFeedSubscribers.add(c.user_id));
  }

  // Telegram Bot routes

  registerBotRoutes(bot, {
    userRepo,
    autopilotRepo,
    sniperRepo,
    walletService,
    scannerService,
    securityService,
    analyzerService,
    scanAnalyzerService,
    tradeRepo,
    traderService,
    copyTradeRepo,
    secureMessageDeleteQueue: queues.secureMessageDeleteQueue,
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
      copyTradeTracker.stop();
      await monitorWorker.close();
      await reconcileWorker.close();
      await secureMessageDeleteWorker.close();
      await queues.scanQueue.close();
      await queues.evalQueue.close();
      await queues.execQueue.close();
      await queues.monitorQueue.close();
      await queues.reconcileQueue.close();
      await queues.secureMessageDeleteQueue.close();
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
