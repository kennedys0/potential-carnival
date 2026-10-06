import { Connection } from '@solana/web3.js';

export interface SellSimulationResult {
  canSell: boolean;
  effectiveTaxPercent: number;
  priceImpactPct: number;
  reason?: string;
}

export class HoneypotSimulator {
  constructor(
    private readonly jupiterClient: any,
    private readonly connection: Connection
  ) {}

  async simulateSell(tokenMint: string): Promise<SellSimulationResult> {
    try {
      // 1. Dapatkan quote jual untuk token ke WSOL
      const quote = await this.jupiterClient.getQuote({
        inputMint: tokenMint,
        outputMint: 'So11111111111111111111111111111111111111112', // Wrapped SOL
        amount: 1000000,
        slippageBps: 200,
      });

      if (!quote || !quote.outAmount) {
        return {
          canSell: false,
          effectiveTaxPercent: 100,
          priceImpactPct: 100,
          reason: 'No sell route found on Jupiter',
        };
      }

      const priceImpact = parseFloat(quote.priceImpactPct || '0');

      return {
        canSell: true,
        effectiveTaxPercent: 0,
        priceImpactPct: priceImpact,
      };
    } catch (err: any) {
      return {
        canSell: false,
        effectiveTaxPercent: 100,
        priceImpactPct: 100,
        reason: err.message || 'Sell simulation failed',
      };
    }
  }
}
