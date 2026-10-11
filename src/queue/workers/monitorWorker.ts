import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, MonitorJobPayload } from '../queues';
import { TradeRepository } from '../../database/repositories/tradeRepository';
import { TraderService } from '../../modules/trader/traderService';
import { ScannerService } from '../../modules/scanner/scannerService';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { SniperRepository } from '../../database/repositories/sniperRepository';
import { sniperExitPolicy } from '../../modules/autopilot/strategyRisk';
import { logger } from '../../utils/logger';
import { JupiterClient } from '../../modules/trader/jupiterClient';
import { appSettings } from '../../config/settings';
import { escapeHtml } from '../../modules/telegram/formatters/messageFormatter';
import { currencyService } from '../../utils/currencyService';
import crypto from 'node:crypto';

export function createMonitorWorker(
  tradeRepo: TradeRepository,
  traderService: TraderService,
  scannerService: ScannerService,
  autopilotRepo: AutopilotRepository,
  jupiterClient: JupiterClient,
  botApi: any,
  sniperRepo?: SniperRepository
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
        if (trade.source !== 'AUTOPILOT') {
          logger.info({ positionId, source: trade.source }, 'Skipping non-autopilot position monitoring');
          return;
        }

        // Use immutable per-position exit policy, not current unrelated strategy settings.
        // Legacy sniper positions without a snapshot use Sniper settings, NEVER Trending.
        let exitParams: Record<string, any>;
        if (trade.exit_policy_snapshot) {
          exitParams = trade.exit_policy_snapshot;
        } else if (trade.strategy === 'NEW_TOKEN_SNIPER') {
          if (!sniperRepo) throw new Error('Missing sniper repository for legacy position exit policy');
          const sniperConfig = await sniperRepo.getOrCreateConfig(userId);
          exitParams = sniperExitPolicy(sniperConfig);
        } else {
          const config = await autopilotRepo.getOrCreateConfig(userId);
          exitParams = (config.exit_params as Record<string, any>) ?? {};
        }
        
        // Get current price
        let pnlPercent = 0;
        let currentPriceUsd = 0;
        let independentPriceUsd = 0;
        let pnlSol = 0;

        if (trade.is_dry_run) {
           const pair = await scannerService.scanTokenByAddress(tokenMint);
           if (!pair) return;
           currentPriceUsd = parseFloat(pair.priceUsd || '0');
           if (currentPriceUsd <= 0) return;
           independentPriceUsd = currentPriceUsd;
           const entryPrice = trade.entry_price_usd;
           pnlPercent = ((currentPriceUsd - entryPrice) / entryPrice) * 100;
           pnlSol = trade.sol_amount * (pnlPercent / 100);
        } else {
           // Live trading: use Jupiter Quote
           if (!trade.remaining_raw) {
              logger.warn({ positionId }, 'Missing remaining_raw on live trade');
              return;
           }
           
           const remainingBigInt = BigInt(trade.remaining_raw);
           if (remainingBigInt <= 0n) return;
           
           const WSOL_MINT = 'So11111111111111111111111111111111111111112';
           const slippageBps = 100; // default for monitoring estimation
           
           try {
             const quote = await jupiterClient.getQuote(trade.token_mint, WSOL_MINT, remainingBigInt, slippageBps);
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

             pnlSol = solToReceive - solSpent;
             pnlPercent = ((solToReceive - solSpent) / solSpent) * 100;
             currentPriceUsd = trade.entry_price_usd * (solToReceive / solSpent);
           } catch (e) {
             logger.error({ e, positionId }, 'Failed to quote for position monitoring');
             return; // try again next time
           }
        }

        // Take Profit & Stop Loss logic
        if (exitParams.enabled === false) return;
        const tp1Percent = exitParams.tp1_percent ?? appSettings.MONITOR_PARAMS.DEFAULT_TP1_PERCENT;
        const tp2Percent = exitParams.tp2_percent ?? appSettings.MONITOR_PARAMS.DEFAULT_TP2_PERCENT;
        const slPercent = exitParams.sl_percent ?? appSettings.MONITOR_PARAMS.DEFAULT_SL_PERCENT;
        const tp1SellShare = Math.min(100, Math.max(1, Number(
          exitParams.tp1_sell_share ?? appSettings.MONITOR_PARAMS.DEFAULT_TP1_SELL_SHARE,
        )));
        
        let percentageToClose = 0;
        let reason = '';
        let emergencyExit = false;

        // Track highest PnL for trailing stop
        let highestPnl = trade.highest_pnl_percent ?? pnlPercent;
        if (pnlPercent > highestPnl) {
            highestPnl = pnlPercent;
            await tradeRepo.updateTradeStatus(trade.id!, { highest_pnl_percent: highestPnl });
        }

        const trailingStopEnabled = exitParams.trailing_stop_enabled ?? true;
        const trailingStopPercent = exitParams.trailing_stop_delta_percent
          ?? exitParams.trailing_stop_percent
          ?? appSettings.MONITOR_PARAMS.DEFAULT_TRAILING_STOP_PERCENT;
        const trailingActivationPercent = exitParams.trailing_activation_percent ?? appSettings.MONITOR_PARAMS.DEFAULT_TRAILING_ACTIVATION_PERCENT; // active only when highest > this

        if (trade.status === 'OPEN' && pnlPercent >= tp1Percent && pnlPercent < tp2Percent) {
           percentageToClose = tp1SellShare;
           reason = `TP1 Reached (+${pnlPercent.toFixed(2)}%)`;
        } else if (pnlPercent >= tp2Percent) {
           percentageToClose = 100;
           reason = `TP2 Reached (+${pnlPercent.toFixed(2)}%)`;
        } else if (trailingStopEnabled && highestPnl >= trailingActivationPercent && (highestPnl - pnlPercent) >= trailingStopPercent) {
           percentageToClose = 100;
           reason = `Trailing Stop Triggered (Highest: ${highestPnl.toFixed(2)}%, Current: ${pnlPercent.toFixed(2)}%)`;
           emergencyExit = !trade.is_dry_run;
        } else if (pnlPercent <= -slPercent) {
           percentageToClose = 100;
           reason = `Stop Loss Reached (${pnlPercent.toFixed(2)}%)`;
           emergencyExit = !trade.is_dry_run;
        }

        if (percentageToClose > 0) {
          let exitReferencePriceUsd = independentPriceUsd;
          if (!trade.is_dry_run) {
            if (emergencyExit) {
              // The Jupiter route quote already showed the loss trigger. Do not
              // let a failed/stale secondary oracle disable loss containment.
              exitReferencePriceUsd = currentPriceUsd;
            } else {
              const independentPair = await scannerService.scanTokenByAddress(tokenMint);
              exitReferencePriceUsd = Number(independentPair?.priceUsd);
              if (!Number.isFinite(exitReferencePriceUsd) || exitReferencePriceUsd <= 0) {
                logger.warn({ positionId, reason }, 'Independent market price unavailable; refusing non-emergency exit');
                return;
              }
            }
          }

          const lockKey = `lock:monitor:close:${positionId}`;
          const lockOwner = crypto.randomUUID();
          const locked = await redis.set(lockKey, lockOwner, 'EX', 120, 'NX');
          if (!locked) {
            logger.info({ positionId }, 'Position is currently being closed by another worker, skipping');
            return;
          }
          
          logger.info({ positionId, reason, percentageToClose }, 'Exiting position');
          try {
            const status = emergencyExit
              ? await traderService.closePosition(trade, exitReferencePriceUsd, percentageToClose, {
                  mode: 'EMERGENCY_EXIT',
                  reason,
                })
              : await traderService.closePosition(trade, exitReferencePriceUsd, percentageToClose);
            try {
              const statusEmoji = pnlPercent >= 0 ? '🟢' : '🔴';
              const actionTitle = pnlPercent >= 0 ? 'TAKE PROFIT REACHED' : 'STOP LOSS TRIGGERED';
              
              await currencyService.fetchRates();
              const pnlIdr = currencyService.solToIdr(pnlSol);
              const sign = pnlSol >= 0 ? '+' : '';
              const idrFormatted = currencyService.formatIdr(pnlIdr === null ? null : Math.abs(pnlIdr));

              if (status === 'SUCCESS') {
                await botApi.sendMessage(userId, 
                  `${statusEmoji} <b>${actionTitle}</b>\n\n` +
                  `Token: <b>${escapeHtml(trade.token_symbol)}</b>\n` +
                  `Status: Tertutup (${percentageToClose}%)\n` +
                  `Entry: $${trade.entry_price_usd.toFixed(6)}\n` +
                  `Exit: $${currentPriceUsd.toFixed(6)}\n` +
                  `PnL: ${sign}${pnlSol.toFixed(4)} SOL (${sign}${idrFormatted})\n\n` +
                  `Alasan: ${escapeHtml(reason)}`,
                  { parse_mode: 'HTML' }
                );
              } else if (status === 'UNCERTAIN') {
                await botApi.sendMessage(userId, 
                  `⏳ <b>CLOSE POSITION SENT</b>\n\n` +
                  `Token: <b>${escapeHtml(trade.token_symbol)}</b>\n` +
                  `Status: Menunggu Konfirmasi Jaringan\n` +
                  `Alasan: ${escapeHtml(reason)}`,
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
          } finally {
            const releaseScript = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              end
              return 0
            `;
            await redis.eval(releaseScript, 1, lockKey, lockOwner).catch((error) => {
              logger.error({ err: error, positionId }, 'Failed to release monitor close lock');
            });
          }
        }

      } catch (err) {
        logger.error({ err, positionId }, 'Failed to monitor position');
        throw err;
      }
    },
    { connection: redis, concurrency: appSettings.MONITOR_WORKER_CONCURRENCY }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Monitor job failed');
  });

  return worker;
}
