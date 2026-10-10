import { logger } from '../../utils/logger';
import { Connection } from '@solana/web3.js';
import { FactorResult } from './scoreCalculator';

export interface SellSimulationResult {
  canSell: FactorResult<boolean>;
  effectiveTaxPercent: FactorResult<number>;
  priceImpactPct: FactorResult<number>;
}

export class HoneypotSimulator {
  constructor(
    private readonly jupiterClient: any,
    private readonly connection: Connection
  ) {}

  async simulateSell(tokenMint: string): Promise<SellSimulationResult> {
    try {
      if (!this.jupiterClient) {
        throw new Error('Jupiter client not initialized');
      }
      // 1. Dapatkan quote beli dari WSOL ke Token (0.01 SOL = 10,000,000 lamports)
      const amountInSolLamports = 10_000_000;
      const wsolMint = 'So11111111111111111111111111111111111111112';
      
      const buyQuote = await this.jupiterClient.getQuote(wsolMint, tokenMint, amountInSolLamports, 200);

      if (!buyQuote || !buyQuote.outAmount) {
        return {
          canSell: { value: false, status: 'OK', source: 'Jupiter Quote API' },
          effectiveTaxPercent: { value: null, status: 'UNAVAILABLE', source: 'No buy route found' },
          priceImpactPct: { value: null, status: 'UNAVAILABLE', source: 'Jupiter Quote API' },
        };
      }

      const tokenReceived = BigInt(buyQuote.outAmount);

      // 2. Dapatkan quote jual dari Token ke WSOL
      const sellQuote = await this.jupiterClient.getQuote(tokenMint, wsolMint, tokenReceived, 200);

      if (!sellQuote || !sellQuote.outAmount) {
        return {
          canSell: { value: false, status: 'OK', source: 'Jupiter Quote API' },
          effectiveTaxPercent: { value: null, status: 'UNAVAILABLE', source: 'No sell route found' },
          priceImpactPct: { value: null, status: 'UNAVAILABLE', source: 'Jupiter Quote API' },
        };
      }

      const solReturned = BigInt(sellQuote.outAmount);
      
      // Hitung rugi fee (tax)
      let effectiveTaxPercent = 0;
      if (solReturned < BigInt(amountInSolLamports)) {
         effectiveTaxPercent = Number((BigInt(amountInSolLamports) - solReturned) * 10_000n / BigInt(amountInSolLamports)) / 100;
      }

      const priceImpact = Number(sellQuote.priceImpactPct || '0') * 100;
      
      // Jika rugi > 30%, asumsikan honeypot ekstrim
      const canSell = effectiveTaxPercent < 30;

      return {
        canSell: { value: canSell, status: 'OK', source: 'Jupiter V2 roundtrip route quote; execution simulation occurs before signing' },
        effectiveTaxPercent: { value: effectiveTaxPercent, status: 'OK', source: 'Jupiter V2 quoted roundtrip loss' },
        priceImpactPct: { value: priceImpact, status: 'OK', source: 'Jupiter Swap API V2' },
      };
    } catch (err: any) {
      const isRateLimit = err?.response?.status === 429 || err?.status === 429 || err.message?.includes('429');
      if (isRateLimit) {
        logger.warn('Jupiter API rate limit reached (429). Cannot simulate sell.');
        return {
          canSell: { value: null, status: 'UNAVAILABLE', source: 'Jupiter Rate Limited' },
          effectiveTaxPercent: { value: null, status: 'UNAVAILABLE', source: 'Jupiter Rate Limited' },
          priceImpactPct: { value: null, status: 'UNAVAILABLE', source: 'Jupiter Rate Limited' },
        };
      }

      const isRouteError = err.name === 'ResponseError' || err.message?.includes('Response returned an error code') || err.message?.includes('Failed to get quote');
      if (isRouteError) {
        logger.debug({ err: err.message }, 'Jupiter API refused simulation (likely no route or liquidity)');
        return {
          canSell: { value: false, status: 'OK', source: 'Jupiter Quote Failed' },
          effectiveTaxPercent: { value: null, status: 'UNAVAILABLE', source: 'Jupiter Quote Failed' },
          priceImpactPct: { value: null, status: 'UNAVAILABLE', source: 'Jupiter Quote Failed' },
        };
      }
      
      logger.error({ err }, 'Simulation Error details:');
      return {
        canSell: { value: null, status: 'UNAVAILABLE', source: `Simulation Error: ${err.message}` },
        effectiveTaxPercent: { value: null, status: 'UNAVAILABLE', source: `Simulation Error: ${err.message}` },
        priceImpactPct: { value: null, status: 'UNAVAILABLE', source: `Simulation Error: ${err.message}` },
      };
    }
  }
}
