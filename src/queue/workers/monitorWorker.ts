import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, MonitorJobPayload } from '../queues';
import { TradeRepository } from '../../database/repositories/tradeRepository';
import { TraderService } from '../../modules/trader/traderService';
import { ScannerService } from '../../modules/scanner/scannerService';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { logger } from '../../utils/logger';
import { JupiterClient } from '../../modules/trader/jupiterClient';
import { appSettings } from '../../config/settings';

export function createMonitorWorker(
  tradeRepo: TradeRepository,
  traderService: TraderService,
  scannerService: ScannerService,
  autopilotRepo: AutopilotRepository,
  jupiterClient: JupiterClient,
  botApi: any
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
           if (!trade.remaining_raw) {
              logger.warn({ positionId }, 'Missing remaining_raw on live trade');
              return;
           }
           
           const remainingBigInt = BigInt(trade.remaining_raw);
           if (remainingBigInt <= 0n) return;
           
           if (remainingBigInt > 9007199254740991n) {
              logger.error({ positionId, remaining: trade.remaining_raw }, 'Remaining tokens too large for safe integer conversion during monitoring');
              return;
           }
           const amountLamports = Number(remainingBigInt);
           const WSOL_MINT = 'So11111111111111111111111111111111111111112';
           const slippageBps = 100; // default for monitoring estimation
           
           try {
             const quote = await jupiterClient.getQuote(trade.token_mint, WSOL_MINT, amountLamports, slippageBps);
             const solToReceive = parseInt(quote.outAmount) / 1e9;
             
             // Calculate cost basis proportional to remaining_raw
             if (!trade.sol_spent_lamports || !trade.token_amount_raw || BigInt(trade.token_amount_raw) === 0n) {
                logger.warn({ positionId }, 'Missing initial cost basis data');
                return;
             }
             const initialSolSpent = BigInt(trade.sol_spent_lamports);
             const initialTokenAmount = BigInt(trade.token_amount_raw);
             const costBasisLamports = (initialSolSpent * remainingBigInt) / initialTokenAmount;
             const solSpent = Number(costBasisLamports) / 1e9;
             
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
        const tp1Percent = exitParams.tp1_percent ?? appSettings.MONITOR_PARAMS.DEFAULT_TP1_PERCENT;
        const tp2Percent = exitParams.tp2_percent ?? appSettings.MONITOR_PARAMS.DEFAULT_TP2_PERCENT;
        const slPercent = exitParams.sl_percent ?? appSettings.MONITOR_PARAMS.DEFAULT_SL_PERCENT;
        
        let percentageToClose = 0;
        let reason = '';

        // Track highest PnL for trailing stop
        let highestPnl = trade.highest_pnl_percent ?? pnlPercent;
        if (pnlPercent > highestPnl) {
            highestPnl = pnlPercent;
            await tradeRepo.updateTradeStatus(trade.id!, { highest_pnl_percent: highestPnl });
        }

        const trailingStopEnabled = exitParams.trailing_stop_enabled ?? true;
        const trailingStopPercent = exitParams.trailing_stop_percent ?? appSettings.MONITOR_PARAMS.DEFAULT_TRAILING_STOP_PERCENT; // drop distance from highest
        const trailingActivationPercent = exitParams.trailing_activation_percent ?? appSettings.MONITOR_PARAMS.DEFAULT_TRAILING_ACTIVATION_PERCENT; // active only when highest > this

        if (trade.status === 'OPEN' && pnlPercent >= tp1Percent && pnlPercent < tp2Percent) {
           percentageToClose = 50;
           reason = `TP1 Reached (+${pnlPercent.toFixed(2)}%)`;
        } else if (pnlPercent >= tp2Percent) {
           percentageToClose = 100;
           reason = `TP2 Reached (+${pnlPercent.toFixed(2)}%)`;
        } else if (trailingStopEnabled && highestPnl >= trailingActivationPercent && (highestPnl - pnlPercent) >= trailingStopPercent) {
           percentageToClose = 100;
           reason = `Trailing Stop Triggered (Highest: ${highestPnl.toFixed(2)}%, Current: ${pnlPercent.toFixed(2)}%)`;
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
          try {
            const status = await traderService.closePosition(trade, currentPriceUsd, percentageToClose);
            try {
              if (status === 'SUCCESS') {
                await botApi.sendMessage(userId, 
                  `🔔 <b>Monitor Alert!</b>\n\n` +
                  `Posisi <b>${trade.token_symbol}</b> berhasil ditutup (${percentageToClose}%).\n` +
                  `Alasan: ${reason}`,
                  { parse_mode: 'HTML' }
                );
              } else if (status === 'UNCERTAIN') {
                await botApi.sendMessage(userId, 
                  `🔔 <b>Monitor Alert!</b>\n\n` +
                  `Permintaan tutup <b>${trade.token_symbol}</b> (${percentageToClose}%) terkirim.\n` +
                  `Status transaksi saat ini belum pasti (menunggu konfirmasi).`,
                  { parse_mode: 'HTML' }
                );
              }
            } catch (e) {
              logger.error({ err: e }, 'Gagal kirim notifikasi Monitor exit');
            }
          } catch (e: any) {
            if (e.message && e.message.includes('terkunci')) {
              logger.info({ positionId }, 'Position is currently being closed by another worker/request, skipping');
              return;
            }
            throw e;
          }
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
