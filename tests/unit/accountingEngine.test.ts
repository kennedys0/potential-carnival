import { describe, expect, it } from 'vitest';
import { AccountingEngine } from '../../src/modules/trader/accountingEngine';

const trade = (overrides: Record<string, unknown> = {}) => ({
  user_id: 1,
  token_mint: 'mint',
  token_symbol: 'TOK',
  side: 'BUY' as const,
  source: 'AUTOPILOT' as const,
  is_dry_run: false,
  sol_amount: 1,
  token_amount: 10,
  entry_price_usd: 1,
  status: 'OPEN' as const,
  token_amount_raw: '10',
  remaining_raw: '10',
  sol_spent_lamports: '1000000000',
  fee_lamports: '9',
  realized_pnl_sol: 0,
  pnl_percent: 0,
  ...overrides,
});

describe('AccountingEngine entry fee allocation', () => {
  it('allocates entry fee cumulatively across partial exits without rounding loss', () => {
    const first = AccountingEngine.calculateExit({
      trade: trade(),
      actualTokensSpentRaw: 3n,
      solReceivedLamports: 400_000_000n,
      feeLamports: 1n,
    });
    expect(first.realizedPnlSol).toBeCloseTo((400_000_000 - 300_000_000 - 2 - 1) / 1e9, 12);

    const second = AccountingEngine.calculateExit({
      trade: trade({
        remaining_raw: '7',
        realized_pnl_sol: first.realizedPnlSol,
        pnl_percent: first.pnlPercent,
      }),
      actualTokensSpentRaw: 7n,
      solReceivedLamports: 700_000_000n,
      feeLamports: 1n,
    });

    expect(second.newStatus).toBe('CLOSED');
    expect(second.realizedPnlSol).toBeCloseTo((1_100_000_000 - 1_000_000_000 - 9 - 2) / 1e9, 12);
  });

  it('includes both entry and exit fees in realized percentage', () => {
    const result = AccountingEngine.calculateExit({
      trade: trade({ fee_lamports: '10000000' }),
      actualTokensSpentRaw: 10n,
      solReceivedLamports: 1_200_000_000n,
      feeLamports: 5_000_000n,
    });

    expect(result.realizedPnlSol).toBeCloseTo(0.185, 12);
    expect(result.pnlPercent).toBeCloseTo((0.185 / 1.01) * 100, 10);
  });
});
