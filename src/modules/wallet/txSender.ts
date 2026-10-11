import { Connection, VersionedTransaction, Keypair, SignatureStatus } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '../../utils/logger';
import { appSettings } from '../../config/settings';

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
      timeoutMs?: number;
      onSignature?: (signature: string) => Promise<void>;
      onSend?: () => Promise<void>;
    } = {}
  ): Promise<TxSendResult> {
    const { pollingIntervalMs = 2000, onSignature, onSend } = options;

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

    if (onSend) {
      try {
        await onSend();
      } catch (e) {
        logger.error({ err: e }, 'onSend callback failed');
        return { status: 'PERSISTENCE_FAILED', signature, err: e };
      }
    }

    try {
      await connection.sendTransaction(transaction, {
        maxRetries: 0,
        preflightCommitment: 'confirmed',
      });
    } catch (e: any) {
      logger.error({ err: e }, 'Failed to sendTransaction initially. Treating as UNCERTAIN and proceeding to poll.');
      // Konservatif: Jika ada error saat sendTransaction (termasuk timeout/network),
      // transaksi MUNGKIN sudah ter-broadcast ke jaringan. 
      // Kita lanjutkan ke proses polling untuk memastikan status akhirnya via getSignatureStatuses.
    }
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || appSettings.TX_POLLING_TIMEOUT_MS;

    // Poll until confirmed/finalized, blockhash is invalid, or timeout
    while (true) {
      if (Date.now() - startTime > timeoutMs) {
        logger.warn({ signature }, 'Polling timeout reached');
        return { status: 'SUBMISSION_TIMEOUT', signature, err: 'Polling timeout' };
      }

      let statusRes;
      try {
        statusRes = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      } catch (err: any) {
        logger.warn({ err, signature }, 'RPC error fetching signature statuses during polling, will retry');
        await new Promise(resolve => setTimeout(resolve, pollingIntervalMs));
        continue;
      }
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
      let isValid;
      try {
        isValid = await connection.isBlockhashValid(recentBlockhash, { commitment: 'confirmed' });
      } catch (err: any) {
        logger.warn({ err, signature }, 'RPC error checking blockhash validity, will retry');
        await new Promise(resolve => setTimeout(resolve, pollingIntervalMs));
        continue;
      }

      if (!isValid.value) {
        logger.warn({ signature }, 'Blockhash expired while waiting for confirmation');
        
        // Final check just in case it got confirmed exactly when blockhash expired
        let finalCheck;
        try {
          finalCheck = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        } catch (err: any) {
          logger.warn({ err, signature }, 'RPC error during final check. Returning UNKNOWN.');
          return { status: 'UNKNOWN', signature, err: err.message };
        }
        const finalStatus = finalCheck.value[0];
        
        if (finalStatus) {
           if (finalStatus.err) return { status: 'FAILED_ONCHAIN', signature, err: finalStatus.err };
           if (finalStatus.confirmationStatus === 'confirmed' || finalStatus.confirmationStatus === 'finalized') {
             return { status: 'SUCCESS', signature };
           }
        }
        
        // A single RPC returning no status is not proof that every validator
        // missed the transaction. Keep the signed outcome non-terminal.
        return {
          status: 'UNKNOWN',
          signature,
          err: 'Blockhash expired but the signed transaction outcome remains unproven',
        };
      }

      await new Promise(resolve => setTimeout(resolve, pollingIntervalMs));
    }
  }
}
