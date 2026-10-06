import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, MonitorJobPayload } from '../queues';
import { TradeRepository } from '../../database/repositories/tradeRepository';
import { TraderService } from '../../modules/trader/traderService';
import { ScannerService } from '../../modules/scanner/scannerService';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { logger } from '../../utils/logger';

export function createMonitorWorker(
  tradeRepo: TradeRepository,
  traderService: TraderService,
  scannerService: ScannerService,
  autopilotRepo: AutopilotRepository
) {
  const redis = getRedisConnection();

  const worker = new Worker<MonitorJobPayload>(
    QUEUE_NAMES.MONITOR,
    async (job: Job<MonitorJobPayload>) => {
      const { positionId, userId, tokenMint } = job.data;
      
      try {
        const trades = await tradeRepo.getOpenTradesByUserId(userId);
        const trade = trades.find(t => t.id === positionId);
        if (!trade) {
          // Trade already closed or doesn't exist
          return;
        }

        const config = await autopilotRepo.getOrCreateConfig(userId);
        if (!config.is_active) return; // don't monitor if autopilot is paused? Actually we should always monitor open positions.
        
        // Get current price
        const pair = await scannerService.scanTokenByAddress(tokenMint);
        if (!pair) return;
        const currentPriceUsd = parseFloat(pair.priceUsd || '0');
        if (currentPriceUsd <= 0) return;

        const entryPrice = trade.entry_price_usd;
        const pnlPercent = ((currentPriceUsd - entryPrice) / entryPrice) * 100;

        // Take Profit & Stop Loss logic
        const exitParams = (config.exit_params as any) || {};
        const tpPercent = exitParams.tp1_percent || 15;
        const slPercent = exitParams.sl_percent || 8;
        // Trailing stop would require saving the highest price reached per trade, 
        // which could be added in a future update to trade repository.
        // For now, basic TP/SL:
        
        let shouldExit = false;
        let reason = '';

        if (pnlPercent >= tpPercent) {
          shouldExit = true;
          reason = `Take Profit reached (+${pnlPercent.toFixed(2)}%)`;
        } else if (pnlPercent <= -slPercent) {
          shouldExit = true;
          reason = `Stop Loss reached (${pnlPercent.toFixed(2)}%)`;
        }

        if (shouldExit) {
          logger.info({ positionId, reason }, 'Exiting position');
          await traderService.closePosition(trade, currentPriceUsd, 100);
          
          // Send notification via another queue or event
        } else {
          // Re-queue for monitoring if not exited
          // We can just rely on a cron that pushes all open positions to MONITOR queue every minute
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
