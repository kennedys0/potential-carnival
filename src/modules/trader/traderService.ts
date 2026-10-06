import { TradeRepository, TradeRecord } from '../../database/repositories/tradeRepository';

export interface OrderRequest {
  userId: number;
  tokenMint: string;
  tokenSymbol: string;
  solAmount: number;
  currentPriceUsd: number;
  isDryRun: boolean;
  source: 'MANUAL' | 'AUTOPILOT';
  slippageBps?: number;
}

export class TraderService {
  constructor(
    private readonly tradeRepo: TradeRepository,
    private readonly jupiterClient?: any
  ) {}

  calculateDynamicSlippage(baseSlippageBps: number, priceImpactPct: number, maxSlippageBps: number): number {
    const dynamicBps = Math.round(baseSlippageBps + priceImpactPct * 120);
    return Math.min(dynamicBps, maxSlippageBps);
  }

  async executeOrder(req: OrderRequest): Promise<TradeRecord> {
    if (req.isDryRun) {
      // Paper Trading: Simulate execution with real market price and negligible fee
      const tokenAmount = req.currentPriceUsd > 0 ? (req.solAmount * 150) / req.currentPriceUsd : 0;
      return this.tradeRepo.createTrade({
        user_id: req.userId,
        token_mint: req.tokenMint,
        token_symbol: req.tokenSymbol,
        side: 'BUY',
        source: req.source,
        is_dry_run: true,
        sol_amount: req.solAmount,
        token_amount: tokenAmount,
        entry_price_usd: req.currentPriceUsd,
        fee_lamports: 5000,
        status: 'OPEN',
      });
    }

    if (!this.jupiterClient) {
      throw new Error('Jupiter client required for live trade execution');
    }

    throw new Error('Live trading requires verified confirmation and unlocked wallet');
  }
}
