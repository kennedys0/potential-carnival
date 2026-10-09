import { VersionedTransaction } from '@solana/web3.js';
import { logger } from '../../utils/logger';

export interface PumpPortalTradeParams {
  publicKey: string;
  action: 'buy' | 'sell';
  mint: string;
  amount: number | string;
  denominatedInSol: boolean;
  slippage: number; // in percent (e.g. 10)
  priorityFee: number; // in SOL (e.g. 0.0001)
  pool?: 'pump' | 'raydium';
}

export class PumpPortalClient {
  private readonly baseUrl = 'https://pumpportal.fun/api/trade-local';

  async getSwapTransaction(params: PumpPortalTradeParams): Promise<{ transaction: VersionedTransaction }> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: params.publicKey,
          action: params.action,
          mint: params.mint,
          denominatedInSol: params.denominatedInSol ? "true" : "false",
          amount: params.amount,
          slippage: params.slippage,
          priorityFee: params.priorityFee,
          pool: params.pool || 'pump',
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`PumpPortal API Error (${response.status}): ${errText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const transaction = VersionedTransaction.deserialize(new Uint8Array(arrayBuffer));
      
      return { transaction };
    } catch (err: any) {
      logger.error({ err, params }, 'PumpPortal getSwapTransaction failed');
      throw err;
    }
  }
}
