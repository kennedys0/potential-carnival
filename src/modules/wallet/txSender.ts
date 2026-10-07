import { Connection, VersionedTransaction, Keypair, SignatureStatus } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '../../utils/logger';

export type TxSendStatus = 'SUCCESS' | 'FAILED_ONCHAIN' | 'UNKNOWN' | 'NOT_SENT';

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
      // If sign fails, no signature is generated, but we MUST return a string, maybe fake or throw?
      // Wait, "Dilarang signature: '' yang ambigu." We can just throw or return NOT_SENT with a placeholder.
      // But actually, we don't even have a tx signature. Let's return 'NOT_SENT_SIGN_FAILED' as signature so it's not empty, or throw.
      return { status: 'NOT_SENT', signature: 'SIGN_FAILED', err: e };
    }

    const signature = bs58.encode(transaction.signatures[0]);
    const recentBlockhash = transaction.message.recentBlockhash;
    
    if (onSignature) {
      await onSignature(signature).catch(e => logger.error({ err: e }, 'onSignature callback failed'));
    }

    try {
      await connection.sendTransaction(transaction, {
        maxRetries,
        preflightCommitment: 'confirmed',
      });
    } catch (e: any) {
      logger.error({ err: e }, 'Failed to sendTransaction initially');
      // sendTransaction might fail before even going to the network (e.g. preflight failure)
      return { status: 'NOT_SENT', signature, err: e };
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
        
        return { status: 'UNKNOWN', signature, err: 'Blockhash expired' };
      }

      await new Promise(resolve => setTimeout(resolve, pollingIntervalMs));
    }
  }
}
