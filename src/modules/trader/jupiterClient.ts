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
    
    try {
      const quote = await this.api.quoteGet({
        inputMint,
        outputMint,
        amount: amountLamports,
        slippageBps,
      });
      
      if (!quote) throw new Error('Failed to get quote from Jupiter API');
      return quote;
    } catch (err: any) {
      if (err.response && typeof err.response.text === 'function') {
        const text = await err.response.text().catch(() => '');
        throw new Error(`Jupiter Quote API Error: ${err.message} - Body: ${text}`);
      }
      throw err;
    }
  }

  async getSwapTransaction(
    quoteResponse: QuoteResponse,
    userPublicKey: string
  ): Promise<{ transaction: VersionedTransaction; lastValidBlockHeight?: number }> {
    await this.waitForRateLimit();

    try {
      const swap = await this.api.swapPost({
        swapRequest: {
          quoteResponse,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 500000 as any, // 0.0005 SOL
        }
      });

      if (!swap || !swap.swapTransaction) {
        throw new Error('Failed to generate swap transaction from Jupiter API');
      }

      const swapTransactionBuf = Buffer.from(swap.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      return { transaction, lastValidBlockHeight: swap.lastValidBlockHeight };
    } catch (err: any) {
      if (err.response && typeof err.response.text === 'function') {
        const text = await err.response.text().catch(() => '');
        throw new Error(`Jupiter Swap API Error: ${err.message} - Body: ${text}`);
      }
      throw err;
    }
  }
}
