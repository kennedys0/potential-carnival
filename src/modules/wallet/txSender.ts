import { Connection, VersionedTransaction, Keypair, SignatureStatus } from '@solana/web3.js';
import { logger } from '../../utils/logger';

export type TxSendStatus = 'SUCCESS' | 'FAILED_ONCHAIN' | 'UNKNOWN';

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
    const { maxRetries = 3, pollingIntervalMs = 2000, onSignature } = options;

    try {
      transaction.sign(signers);
    } catch (e) {
      logger.error({ err: e }, 'Failed to sign transaction');
      return { status: 'UNKNOWN', signature: '', err: e };
    }

    const recentBlockhash = transaction.message.recentBlockhash;
    let signature = '';
    
    try {
      signature = await connection.sendTransaction(transaction, {
        maxRetries,
        preflightCommitment: 'confirmed',
      });
      if (onSignature) {
        await onSignature(signature).catch(e => logger.error({ err: e }, 'onSignature callback failed'));
      }
    } catch (e: any) {
      logger.error({ err: e }, 'Failed to sendTransaction initially');
      // sendTransaction might fail before even going to the network, but we'll try to extract a signature or just return UNKNOWN
      if (!signature) {
        return { status: 'UNKNOWN', signature: '', err: e };
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
      const isValid = await connection.isBlockhashValid(recentBlockhash, 'confirmed');
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
        
        return { status: 'UNKNOWN', signature, err: 'Blockhash expired' };
      }

      await new Promise(resolve => setTimeout(resolve, pollingIntervalMs));
    }
  }
}
