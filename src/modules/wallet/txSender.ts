import { Connection, VersionedTransaction, Keypair, SignatureStatus } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '../../utils/logger';

export type TxSendStatus = 
  | 'SIGN_FAILED'
  | 'PERSISTENCE_FAILED'
  | 'SUBMISSION_REJECTED'
  | 'SUBMISSION_TIMEOUT'
  | 'CONFIRMING'
  | 'SUCCESS'
  | 'FAILED_ONCHAIN'
  | 'EXPIRED'
  | 'UNKNOWN';

export interface TxSendResult {
  status: TxSendStatus;
  signature: string;
  err?: any;
}

export class TxSender {
  static async sendAndConfirm(
    connection: Connection,
    transaction: VersionedTransaction,
    signers: Keypair[],
    options: {
      maxRetries?: number;
      pollingIntervalMs?: number;
      onSignature?: (signature: string) => Promise<void>;
    } = {}
  ): Promise<TxSendResult> {
    const { pollingIntervalMs = 2000, onSignature } = options;

    try {
      transaction.sign(signers);
    } catch (e) {
      logger.error({ err: e }, 'Failed to sign transaction');
      return { status: 'SIGN_FAILED', signature: '', err: e };
    }

    const signature = bs58.encode(transaction.signatures[0]);
    const recentBlockhash = transaction.message.recentBlockhash;
    
    if (onSignature) {
      try {
        await onSignature(signature);
      } catch (e) {
        logger.error({ err: e }, 'onSignature callback failed - persisting signature aborted');
        return { status: 'PERSISTENCE_FAILED', signature, err: e };
      }
    }

    try {
      await connection.sendTransaction(transaction, {
        maxRetries: 0,
        preflightCommitment: 'confirmed',
      });
    } catch (e: any) {
      logger.error({ err: e }, 'Failed to sendTransaction initially');
      
      const errMsg = e.message ? e.message.toLowerCase() : '';
      const isDefiniteRejection = errMsg.includes('blockhash not found') || 
                                  errMsg.includes('invalid') || 
                                  errMsg.includes('signature verification failed');

      if (isDefiniteRejection) {
        return { status: 'SUBMISSION_REJECTED', signature, err: e };
      } else {
        // TCP timeout, rate limit, internal server error, or other ambiguous errors
        // We cannot guarantee the network didn't receive it!
        return { status: 'UNKNOWN', signature, err: e };
      }
    }

    // Poll until confirmed/finalized or blockhash is invalid
    while (true) {
      const statusRes = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = statusRes.value[0];

      if (status) {
        if (status.err) {
          logger.warn({ signature, err: status.err }, 'Transaction failed on-chain');
          return { status: 'FAILED_ONCHAIN', signature, err: status.err };
        }
        
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return { status: 'SUCCESS', signature };
        }
      }

      // Check if blockhash is still valid
      const isValid = await connection.isBlockhashValid(recentBlockhash, { commitment: 'confirmed' });
      if (!isValid.value) {
        logger.warn({ signature }, 'Blockhash expired while waiting for confirmation');
        
        // Final check just in case it got confirmed exactly when blockhash expired
        const finalCheck = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const finalStatus = finalCheck.value[0];
        
        if (finalStatus) {
           if (finalStatus.err) return { status: 'FAILED_ONCHAIN', signature, err: finalStatus.err };
           if (finalStatus.confirmationStatus === 'confirmed' || finalStatus.confirmationStatus === 'finalized') {
             return { status: 'SUCCESS', signature };
           }
        }
        
        return { status: 'EXPIRED', signature, err: 'Blockhash expired' };
      }

      await new Promise(resolve => setTimeout(resolve, pollingIntervalMs));
    }
  }
}
