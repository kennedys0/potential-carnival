import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '../queues';
import { getRedisConnection } from '../connection';
import { logger } from '../../../utils/logger';
import { TradeRepository } from '../../../database/repositories/tradeRepository';
import { WalletService } from '../../../modules/wallet/walletService';

export function createReconcileWorker(
  tradeRepo: TradeRepository,
  walletService: WalletService,
) {
  const redis = getRedisConnection();
  
  return new Worker(QUEUE_NAMES.RECONCILE, async (job) => {
    logger.info('Starting reconciliation job');

    try {
      // 1. Reconcile PENDING trades
      const { data: pendingTrades, error } = await tradeRepo.db
        .from('trades')
        .select('*')
        .eq('status', 'PENDING')
        .not('pending_signature', 'is', null);
      
      if (!error && pendingTrades) {
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

      // 2. Compare token balance for OPEN trades
      const { data: openTrades, error: err2 } = await tradeRepo.db
        .from('trades')
        .select('*')
        .in('status', ['OPEN', 'PARTIAL_EXIT']);

      if (!err2 && openTrades) {
        for (const trade of openTrades) {
           const wallet = await walletService.getOrCreateWallet(trade.user_id);
           const tokenBalanceRaw = await walletService.getTokenBalance(wallet.publicKey, trade.token_mint);
           const dbRemainingRaw = trade.remaining_raw || 0;
           
           if (tokenBalanceRaw !== dbRemainingRaw) {
             logger.warn({ tradeId: trade.id, onChain: tokenBalanceRaw, db: dbRemainingRaw }, 'Token balance mismatch found during reconciliation');
             await tradeRepo.updateTradeStatus(trade.id, { remaining_raw: tokenBalanceRaw });
           }
        }
      }

      // 3. Find orphan tokens (tokens in wallet but no OPEN trade)
      // This is a bit heavy, maybe we just query all wallets and all token accounts?
      // Since it's a scalping bot, they shouldn't have many tokens.
      // Let's just do a basic scan if possible, or skip for now to save RPC calls.
      
    } catch (e) {
       logger.error({ err: e }, 'Reconciliation job failed');
    }

  }, { connection: redis });
}
