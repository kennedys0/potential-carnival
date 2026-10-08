import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '../queues';
import { getRedisConnection } from '../connection';
import { logger } from '../../utils/logger';
import { TradeRepository } from '../../database/repositories/tradeRepository';
import { WalletService } from '../../modules/wallet/walletService';
import { appSettings } from '../../config/settings';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { FillParser } from '../../modules/trader/fillParser.js';

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
             
             if (signature === 'SIGN_FAILED' || trade.status === ('NOT_SENT' as any)) {
               await tradeRepo.updateTradeStatus(trade.id!, {
                 status: 'FAILED',
                 failure_reason: `Reconciled as NOT_SENT`,
               });
               continue;
             }

             const pendingSince = trade.pending_since ? new Date(trade.pending_since).getTime() : 0;
             const ageMs = Date.now() - pendingSince;
             if (pendingSince > 0 && ageMs > appSettings.MAX_PENDING_AGE_MS) {
               await tradeRepo.updateTradeStatus(trade.id!, {
                 needs_attention: true,
               });
               continue;
             }

             const connection = walletService.getConnection();
             const statusRes = await connection.getSignatureStatuses([signature!], { searchTransactionHistory: true });
             const status = statusRes.value[0];
             
             if (status) {
               if (status.err) {
                 await tradeRepo.updateTradeStatus(trade.id!, {
                   status: 'FAILED',
                   failure_reason: `Reconciled as FAILED_ONCHAIN: ${JSON.stringify(status.err)}`,
                 });
                 logger.info({ tradeId: trade.id, signature }, 'Reconciled PENDING trade to FAILED');
               } else if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                 
                 const tx = await walletService.getParsedTransaction(signature!);
                 const wallet = await walletService.getOrCreateWallet(trade.user_id);
                 
                 const parseResult = FillParser.parseBuyFill(tx, wallet.publicKey, trade.token_mint);
                 
                 if (parseResult && parseResult.tokenDeltaRaw > 0n) {
                    await tradeRepo.updateTradeStatus(trade.id!, {
                      status: 'OPEN',
                      tx_signature: signature,
                      remaining_raw: String(parseResult.tokenDeltaRaw),
                      token_decimals: parseResult.decimals,
                      sol_spent_lamports: String(parseResult.solDeltaLamports),
                      token_amount_raw: String(parseResult.tokenDeltaRaw),
                      fee_lamports: Number(parseResult.feeLamports),
                      sol_amount: Number(parseResult.solDeltaLamports) / 1e9,
                      token_amount: Number(parseResult.tokenDeltaRaw) / Math.pow(10, parseResult.decimals)
                    });
                    logger.info({ tradeId: trade.id, signature }, 'Reconciled PENDING trade to OPEN LENGKAP');
                 } else {
                    await tradeRepo.updateTradeStatus(trade.id!, {
                      needs_attention: true,
                    });
                    logger.warn({ tradeId: trade.id, signature }, 'Failed to parse buy fill, marked needs_attention');
                 }
               }
             } else {
               // signature lost, check blockhash
               if (trade.blockhash) {
                 const isValid = await connection.isBlockhashValid(trade.blockhash, { commitment: 'confirmed' });
                 if (!isValid.value) {
                   await tradeRepo.updateTradeStatus(trade.id!, {
                     status: 'FAILED',
                     failure_reason: `Signature lost and blockhash expired`,
                   });
                   logger.info({ tradeId: trade.id }, 'Reconciled PENDING trade to FAILED (blockhash expired)');
                 }
               }
             }
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to fetch pending trades');
      }

      // 1.5 Reconcile PENDING exit_attempts
      try {
        const pendingExits = await tradeRepo.getAllPendingExitAttempts();
        for (const attempt of pendingExits) {
          const attemptAgeMs = Date.now() - new Date(attempt.created_at || Date.now()).getTime();
          
          if (!attempt.tx_signature) {
             // Failed before signature was recorded, or crashed
             if (attemptAgeMs > 60000) { // 60 seconds timeout
                await tradeRepo.updateExitAttempt(attempt.id!, { status: 'FAILED' });
                logger.info({ attemptId: attempt.id }, 'Reconciled PENDING exit attempt to FAILED (timeout without signature)');
             }
             continue;
          }
          
          const connection = walletService.getConnection();
          const statusRes = await connection.getSignatureStatuses([attempt.tx_signature!], { searchTransactionHistory: true });
          const status = statusRes.value[0];
          
          if (status) {
             if (status.err) {
               await tradeRepo.updateExitAttempt(attempt.id!, { status: 'FAILED' });
               logger.info({ attemptId: attempt.id, signature: attempt.tx_signature }, 'Reconciled PENDING exit attempt to FAILED on-chain');
             } else if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
               await tradeRepo.updateExitAttempt(attempt.id!, { status: 'SUCCESS' });
               // The actual trade update should be done by closePosition normally, or by deficit reconciliation below if it crashed before updating trades table
               logger.info({ attemptId: attempt.id, signature: attempt.tx_signature }, 'Reconciled PENDING exit attempt to SUCCESS');
             }
          } else {
             // If signature not found and it's old enough, mark failed
             if (attemptAgeMs > 120000) {
               await tradeRepo.updateExitAttempt(attempt.id!, { status: 'FAILED' });
               logger.info({ attemptId: attempt.id, signature: attempt.tx_signature }, 'Reconciled PENDING exit attempt to FAILED (signature not found)');
             }
          }
        }
      } catch (err) {
         logger.error({ err }, 'Failed to reconcile exit attempts');
      }

      // 2. Compare token balance for OPEN trades
      try {
        const openTrades = await tradeRepo.getOpenTradesOrderedFIFO();
        if (openTrades && openTrades.length > 0) {
          
          for (const t of openTrades) {
             if (t.remaining_raw !== null && t.remaining_raw <= 0) {
                await tradeRepo.updateTradeStatus(t.id!, { needs_attention: true });
                logger.warn({ tradeId: t.id }, 'OPEN trade with remaining_raw <= 0 marked needs_attention');
             }
          }

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
            const tokenBalanceInfo = await walletService.getTokenBalance(wallet.publicKey, tokenMint);
            const tokenBalanceRaw = tokenBalanceInfo.raw;
            
            let sumDbRaw = 0n;
            for (const t of trades) {
              sumDbRaw += BigInt(t.remaining_raw ?? 0);
            }

            if (sumDbRaw > tokenBalanceRaw) {
               logger.warn({ userId, tokenMint, onChain: Number(tokenBalanceRaw), dbSum: Number(sumDbRaw) }, 'Token balance deficit found. Reconciling trades (FIFO)...');
               
               let deficit = sumDbRaw - tokenBalanceRaw;
               
               for (const t of trades) {
                 if (deficit <= 0n) break;
                 
                 const currentRemaining = BigInt(t.remaining_raw ?? 0);
                 if (currentRemaining > 0n) {
                   const toDeduct = currentRemaining < deficit ? currentRemaining : deficit;
                   const newRemaining = currentRemaining - toDeduct;
                   deficit -= toDeduct;
                   
                   const updates: any = { remaining_raw: String(newRemaining), needs_attention: true };
                   if (newRemaining <= 0n) {
                     updates.status = 'CLOSED';
                     updates.closed_at = new Date().toISOString();
                   }
                   await tradeRepo.updateTradeStatus(t.id!, updates);
                   logger.info({ tradeId: t.id, deducted: String(toDeduct), newRemaining: String(newRemaining) }, 'Reconciled missing tokens for trade');
                 }
               }
            }
          }
          
          // Orphan Token scan
          const usersWithTrades = Array.from(new Set(openTrades.map(t => t.user_id)));
          for (const userId of usersWithTrades) {
             const wallet = await walletService.getOrCreateWallet(userId);
             const connection = walletService.getConnection();
             const accounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(wallet.publicKey), { programId: TOKEN_PROGRAM_ID });
             
             for (const acc of accounts.value) {
                const mint = acc.account.data.parsed.info.mint;
                const amountRaw = parseInt(acc.account.data.parsed.info.tokenAmount.amount, 10);
                
                // Dust limit
                const dustLimit = appSettings.ORPHAN_DUST_LIMIT_RAW;
                
                if (amountRaw > dustLimit) {
                   const key = `${userId}:${mint}`;
                   if (!groups.has(key)) {
                      // Found orphan
                      const redisKey = `orphan_alert:${userId}:${mint}`;
                      const lastAlert = await redis.get(redisKey);
                      if (!lastAlert) {
                         logger.warn({ userId, mint, amountRaw }, 'Orphan token found, needs alert');
                         // simulate alert sending
                         // notifyService.sendAlert(...)
                         await redis.set(redisKey, '1', 'EX', 86400); // 1 day
                      }
                   }
                }
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
