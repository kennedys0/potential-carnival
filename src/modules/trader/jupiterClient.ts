import { createJupiterApiClient, QuoteResponse } from '@jup-ag/api';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getEnv } from '../../config/env';

export class JupiterClient {
  private api = createJupiterApiClient();

  constructor(private connection: Connection) {}

  async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps: number
  ): Promise<QuoteResponse> {
    const quote = await this.api.quoteGet({
      inputMint,
      outputMint,
      amount: amountLamports,
      slippageBps,
    });
    
    if (!quote) throw new Error('Failed to get quote from Jupiter API');
    return quote;
  }

  async getSwapTransaction(
    quoteResponse: QuoteResponse,
    userPublicKey: string
  ): Promise<VersionedTransaction> {
    const swap = await this.api.swapPost({
      swapRequest: {
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto' as any,
      }
    });

    if (!swap || !swap.swapTransaction) {
      throw new Error('Failed to generate swap transaction from Jupiter API');
    }

    const swapTransactionBuf = Buffer.from(swap.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    return transaction;
  }
}
