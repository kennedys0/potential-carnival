import { createJupiterApiClient, QuoteResponse } from '@jup-ag/api';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getEnv } from '../../config/env';

export class JupiterClient {
  private api = createJupiterApiClient({
    basePath: process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6',
    apiKey: process.env.JUPITER_API_KEY
  });
  
  private lastRequestTime = 0;
  private requestPromise: Promise<void> = Promise.resolve();
  private readonly minDelay = 2100; // 2.1 seconds to be safe with 1 req / 2s

  constructor(private connection: Connection) {}

  private async waitForRateLimit() {
    const nextPromise = this.requestPromise.then(async () => {
      const now = Date.now();
      const timeSinceLast = now - this.lastRequestTime;
      if (timeSinceLast < this.minDelay) {
        await new Promise(resolve => setTimeout(resolve, this.minDelay - timeSinceLast));
      }
      this.lastRequestTime = Date.now();
    }).catch(() => {
      // In case a previous promise rejected (shouldn't happen here, but safe)
      this.lastRequestTime = Date.now();
    });
    
    this.requestPromise = nextPromise;
    await nextPromise;
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps: number
  ): Promise<QuoteResponse> {
    await this.waitForRateLimit();
    
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
  ): Promise<{ transaction: VersionedTransaction; lastValidBlockHeight?: number }> {
    await this.waitForRateLimit();

    const swap = await this.api.swapPost({
      swapRequest: {
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }
    });

    if (!swap || !swap.swapTransaction) {
      throw new Error('Failed to generate swap transaction from Jupiter API');
    }

    const swapTransactionBuf = Buffer.from(swap.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    return { transaction, lastValidBlockHeight: swap.lastValidBlockHeight };
  }
}
