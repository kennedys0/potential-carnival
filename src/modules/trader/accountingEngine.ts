import { TradeRecord } from '../../database/repositories/tradeRepository';

export interface ExitAccountingParams {
  trade: TradeRecord;
  actualTokensSpentRaw: bigint;
  solReceivedLamports: bigint | string;
  feeLamports: bigint | string;
  currentPriceUsd?: number;
}

export interface ExitAccountingResult {
  newStatus: 'PARTIAL_EXIT' | 'CLOSED';
  pnlPercent: number;
  pnlSol: number;
  realizedPnlSol: number;
  remainingRaw: string;
  exitPriceUsd?: number;
}

export class AccountingEngine {
  static calculateExit(params: ExitAccountingParams): ExitAccountingResult {
    const { trade, actualTokensSpentRaw, currentPriceUsd } = params;
    const solReceivedLamports = BigInt(params.solReceivedLamports);
    const feeLamports = BigInt(params.feeLamports);

    const tradeBalanceRaw = BigInt(trade.remaining_raw ?? 0);
    const newTradeRemainingRaw = tradeBalanceRaw > actualTokensSpentRaw ? tradeBalanceRaw - actualTokensSpentRaw : 0n;
    
    let newStatus: 'PARTIAL_EXIT' | 'CLOSED' = newTradeRemainingRaw <= 0n ? 'CLOSED' : 'PARTIAL_EXIT';
    
    const solReceived = solReceivedLamports > 0n ? Number(solReceivedLamports) / 1e9 : 0;
    
    let realizedPnlSol = trade.realized_pnl_sol ?? 0;
    let pnlPercent = trade.pnl_percent ?? 0;
    
    if (trade.sol_spent_lamports && trade.token_amount_raw && BigInt(trade.token_amount_raw) > 0n) {
      const solSpentLamportsBigInt = BigInt(trade.sol_spent_lamports);
      const tokenAmountRawBigInt = BigInt(trade.token_amount_raw);
      
      const costLamports = (solSpentLamportsBigInt * actualTokensSpentRaw) / tokenAmountRawBigInt;
      const costSol = Number(costLamports) / 1e9;
      const feeSol = Number(feeLamports) / 1e9;
      
      const currentRealized = solReceived - costSol - feeSol;
      realizedPnlSol += currentRealized;
      
      if (costSol > 0) {
        pnlPercent = ((solReceived - costSol) / costSol) * 100;
      }
    }

    const result: ExitAccountingResult = {
      newStatus,
      pnlPercent,
      pnlSol: realizedPnlSol,
      realizedPnlSol,
      remainingRaw: newTradeRemainingRaw.toString(),
    };

    if (newStatus === 'CLOSED' && currentPriceUsd !== undefined) {
      result.exitPriceUsd = currentPriceUsd;
    }

    return result;
  }

  static calculateLiveValuation(params: { trade: TradeRecord, currentPriceUsd: number }): { pnlPercent: number, pnlSol: number } {
    const { trade, currentPriceUsd } = params;
    let pnlPercent = 0;
    let pnlSol = 0;
    
    if (currentPriceUsd > 0 && trade.entry_price_usd > 0 && trade.sol_spent_lamports && trade.token_amount_raw && BigInt(trade.token_amount_raw) > 0n) {
      // Calculate true cost basis for remaining tokens
      const remainingBigInt = BigInt(trade.remaining_raw ?? trade.token_amount_raw);
      const initialSolSpent = BigInt(trade.sol_spent_lamports);
      const initialTokenAmount = BigInt(trade.token_amount_raw);
      
      if (remainingBigInt > 0n) {
        const costBasisLamports = (initialSolSpent * remainingBigInt) / initialTokenAmount;
        const solSpent = Number(costBasisLamports) / 1e9;
        
        // This is a naive translation from price ratio to SOL value,
        // it doesn't account for exit slippage, but at least accounts for entry cost correctly.
        pnlPercent = ((currentPriceUsd - trade.entry_price_usd) / trade.entry_price_usd) * 100;
        pnlSol = solSpent * (pnlPercent / 100);
      }
    }
    
    return { pnlPercent, pnlSol };
  }
}
