import { describe, expect, it, vi } from 'vitest';
import { TradeRepository } from '../../src/database/repositories/tradeRepository';

const baseUpdate = {
  status: 'OPEN' as const,
  tx_signature: 'signed_signature',
  remaining_raw: '1000000',
  token_amount_raw: '1000000',
  token_decimals: 6,
  sol_spent_lamports: '500000000',
  fee_lamports: '5000',
};

function repositoryReturning(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { repo: new TradeRepository({ rpc } as any), rpc };
}

describe('TradeRepository.atomicReconcileEntry - fail-closed SQL contract', () => {
  it.each(['APPLIED', 'ALREADY_APPLIED'])('accepts verified result %s', async (result) => {
    const { repo, rpc } = repositoryReturning(result);
    await expect(repo.atomicReconcileEntry('trade-id', baseUpdate)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('atomic_reconcile_entry', expect.objectContaining({
      p_trade_id: 'trade-id',
      p_tx_signature: 'signed_signature',
      p_token_amount_raw: '1000000',
    }));
  });

  it.each(['ALREADY_RESOLVED', 'INVALID_STATE', 'INVALID_EVIDENCE', 'CONFLICT', null])(
    'rejects non-final or erroneous result %s', async (result) => {
      const { repo } = repositoryReturning(result);
      await expect(repo.atomicReconcileEntry('trade-id', baseUpdate)).rejects.toThrow('Entry reconciliation rejected');
    },
  );

  it('propagates database errors', async () => {
    const { repo } = repositoryReturning(null, { message: 'constraint failed' });
    await expect(repo.atomicReconcileEntry('trade-id', baseUpdate)).rejects.toThrow('constraint failed');
  });
});
