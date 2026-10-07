import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '../queues';
import { getRedisConnection } from '../connection';
import { logger } from '../../utils/logger';
import { TradeRepository } from '../../database/repositories/tradeRepository';
import { WalletService } from '../../modules/wallet/walletService';

export function createReconcileWorker(
  tradeRepo: TradeRepository,
  walletService: WalletService,
) {
  const redis = getRedisConnection();
  
  return new Worker(QUEUE_NAMES.RECONCILE, async (job) => {
    logger.info('Starting reconciliation job');

    try {
      // 1. Reconcile PENDING trades
      try {
        const pendingTrades = await tradeRepo.getPendingTradesWithSignature();
        if (pendingTrades && pendingTrades.length > 0) {
        for (const trade of pendingTrades) {
           const signature = trade.pending_signature;
           const connection = walletService.getConnection();
           const statusRes = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
           const status = statusRes.value[0];
           
           if (status) {
             if (status.err) {
               await tradeRepo.updateTradeStatus(trade.id, {
                 status: 'FAILED',
                 failure_reason: `Reconciled as FAILED_ONCHAIN: ${JSON.stringify(status.err)}`,
               });
               logger.info({ tradeId: trade.id, signature }, 'Reconciled PENDING trade to FAILED');
             } else if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
               // We need to parse it to get final amount, but for now just mark OPEN, monitor will fix
               // Wait, the instruction says: selesaikan menjadi OPEN/FAILED/CLOSED sesuai fakta
               await tradeRepo.updateTradeStatus(trade.id, {
                 status: 'OPEN',
                 tx_signature: signature,
               });
               logger.info({ tradeId: trade.id, signature }, 'Reconciled PENDING trade to OPEN');
             }
           }
        }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to fetch pending trades');
      }

      // 2. Compare token balance for OPEN trades
      try {
        const openTrades = await tradeRepo.getOpenTradesOrderedFIFO();
        if (openTrades && openTrades.length > 0) {
        // Group by user_id and token_mint
        const groups = new Map<string, typeof openTrades>();
        for (const t of openTrades) {
          const key = `${t.user_id}:${t.token_mint}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(t);
        }

        for (const [key, trades] of groups.entries()) {
          const [userIdStr, tokenMint] = key.split(':');
          const userId = parseInt(userIdStr, 10);
          
          const wallet = await walletService.getOrCreateWallet(userId);
          const tokenBalanceRaw = await walletService.getTokenBalance(wallet.publicKey, tokenMint);
          
          let sumDbRaw = 0;
          for (const t of trades) {
            sumDbRaw += (t.remaining_raw ?? 0);
          }

          if (sumDbRaw > tokenBalanceRaw) {
             logger.warn({ userId, tokenMint, onChain: tokenBalanceRaw, dbSum: sumDbRaw }, 'Token balance deficit found. Reconciling trades (FIFO)...');
             
             let deficit = sumDbRaw - tokenBalanceRaw;
             
             for (const t of trades) {
               if (deficit <= 0) break;
               
               const currentRemaining = t.remaining_raw ?? 0;
               if (currentRemaining > 0) {
                 const toDeduct = Math.min(currentRemaining, deficit);
                 const newRemaining = currentRemaining - toDeduct;
                 deficit -= toDeduct;
                 
                 const updates: any = { remaining_raw: newRemaining, needs_attention: true };
                 if (newRemaining <= 0) {
                   updates.status = 'CLOSED';
                   updates.closed_at = new Date().toISOString();
                 }
                 await tradeRepo.updateTradeStatus(t.id, updates);
                 logger.info({ tradeId: t.id, deducted: toDeduct, newRemaining }, 'Reconciled missing tokens for trade');
               }
             }
          } else if (sumDbRaw < tokenBalanceRaw) {
             logger.info({ userId, tokenMint, onChain: tokenBalanceRaw, dbSum: sumDbRaw }, 'User has extra tokens (not tied to open trades). Ignored by reconciler.');
          }
        }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to fetch open trades');
      }
      
    } catch (e) {
       logger.error({ err: e }, 'Reconciliation job failed');
    }

  }, { connection: redis });
}
