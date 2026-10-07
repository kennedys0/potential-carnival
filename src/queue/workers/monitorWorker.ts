import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, MonitorJobPayload } from '../queues';
import { TradeRepository } from '../../database/repositories/tradeRepository';
import { TraderService } from '../../modules/trader/traderService';
import { ScannerService } from '../../modules/scanner/scannerService';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { logger } from '../../utils/logger';
import { JupiterClient } from '../../modules/trader/jupiterClient';

export function createMonitorWorker(
  tradeRepo: TradeRepository,
  traderService: TraderService,
  scannerService: ScannerService,
  autopilotRepo: AutopilotRepository,
  jupiterClient: JupiterClient
) {
  const redis = getRedisConnection();

  const worker = new Worker<MonitorJobPayload>(
    QUEUE_NAMES.MONITOR,
    async (job: Job<MonitorJobPayload>) => {
      const { positionId, userId, tokenMint } = job.data;
      
      try {
        const trades = await tradeRepo.getOpenTradesByUserId(userId);
        const trade = trades.find(t => t.id === positionId);
        if (!trade || !['OPEN', 'PARTIAL_EXIT'].includes(trade.status)) {
          // Trade already closed, pending, or doesn't exist
          return;
        }

        const config = await autopilotRepo.getOrCreateConfig(userId);
        
        // Get current price
        let pnlPercent = 0;
        let currentPriceUsd = 0;

        if (trade.is_dry_run) {
           const pair = await scannerService.scanTokenByAddress(tokenMint);
           if (!pair) return;
           currentPriceUsd = parseFloat(pair.priceUsd || '0');
           if (currentPriceUsd <= 0) return;
           const entryPrice = trade.entry_price_usd;
           pnlPercent = ((currentPriceUsd - entryPrice) / entryPrice) * 100;
        } else {
           // Live trading: use Jupiter Quote
           if (!trade.token_amount_raw) {
              logger.warn({ positionId }, 'Missing token_amount_raw on live trade');
              return;
           }

           const amountLamports = trade.token_amount_raw;
           const WSOL_MINT = 'So11111111111111111111111111111111111111112';
           const slippageBps = 100; // default for monitoring estimation
           
           try {
             const quote = await jupiterClient.getQuote(trade.token_mint, WSOL_MINT, amountLamports, slippageBps);
             const solToReceive = parseInt(quote.outAmount) / 1e9;
             const solSpent = (trade.sol_spent_lamports ?? 0) / 1e9;
             
             if (solSpent <= 0) {
                logger.warn({ positionId }, 'solSpent is 0, cannot calculate PNL');
                return;
             }

             pnlPercent = ((solToReceive - solSpent) / solSpent) * 100;
             currentPriceUsd = trade.entry_price_usd * (solToReceive / solSpent);
           } catch (e) {
             logger.error({ e, positionId }, 'Failed to quote for position monitoring');
             return; // try again next time
           }
        }

        // Take Profit & Stop Loss logic
        const exitParams = (config.exit_params as any) || {};
        const tp1Percent = exitParams.tp1_percent ?? 15;
        const tp2Percent = exitParams.tp2_percent ?? 30;
        const slPercent = exitParams.sl_percent ?? 8;
        
        let percentageToClose = 0;
        let reason = '';

        if (trade.status === 'OPEN' && pnlPercent >= tp1Percent && pnlPercent < tp2Percent) {
           percentageToClose = 50;
           reason = `TP1 Reached (+${pnlPercent.toFixed(2)}%)`;
        } else if (pnlPercent >= tp2Percent) {
           percentageToClose = 100;
           reason = `TP2 Reached (+${pnlPercent.toFixed(2)}%)`;
        } else if (pnlPercent <= -slPercent) {
           percentageToClose = 100;
           reason = `Stop Loss Reached (${pnlPercent.toFixed(2)}%)`;
        }

        if (percentageToClose > 0) {
          const lockKey = `lock:monitor:close:${positionId}`;
          const locked = await redis.set(lockKey, 'locked', 'EX', 30, 'NX');
          if (!locked) {
            logger.info({ positionId }, 'Position is currently being closed by another worker, skipping');
            return;
          }
          
          logger.info({ positionId, reason, percentageToClose }, 'Exiting position');
          await traderService.closePosition(trade, currentPriceUsd, percentageToClose);
        }

      } catch (err) {
        logger.error({ err, positionId }, 'Failed to monitor position');
        throw err;
      }
    },
    { connection: redis }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Monitor job failed');
  });

  return worker;
}
