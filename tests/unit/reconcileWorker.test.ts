import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReconcileWorker } from '../../src/queue/workers/reconcileWorker';
import { logger } from '../../src/utils/logger';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn().mockImplementation((...args) => console.error("TEST LOGGER ERROR:", ...args)),
  },
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name, processor, opts) => {
    return {
      name,
      processor,
      opts,
      close: vi.fn(),
    };
  }),
}));

vi.mock('../../src/queue/connection', () => ({
  getRedisConnection: vi.fn().mockReturnValue({}),
}));

describe('ReconcileWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconciles PENDING trade to FAILED if on-chain failed', async () => {
    const mockTradeRepo: any = {
      getPendingTradesWithSignature: vi.fn().mockResolvedValue([
        { id: 'trade-1', pending_signature: 'sig-1' }
      ]),
      getOpenTradesOrderedFIFO: vi.fn().mockResolvedValue([]),
      updateTradeStatus: vi.fn().mockResolvedValue(true),
    };

    const mockWalletService: any = {
      getConnection: vi.fn().mockReturnValue({
        getSignatureStatuses: vi.fn().mockResolvedValue({
          value: [{ err: { InstructionError: [0, 'error'] } }]
        })
      })
    };

    const worker: any = createReconcileWorker(mockTradeRepo, mockWalletService);
    
    // run the processor manually
    await worker.processor({});

    expect(mockTradeRepo.updateTradeStatus).toHaveBeenCalledWith('trade-1', expect.objectContaining({
      status: 'FAILED'
    }));
  });

  it('reconciles PENDING trade to OPEN completely if on-chain confirmed', async () => {
    const mockTradeRepo: any = {
      getPendingTradesWithSignature: vi.fn().mockResolvedValue([
        { id: 'trade-2', pending_signature: 'sig-2', user_id: 1, token_mint: 'token-A' }
      ]),
      getOpenTradesOrderedFIFO: vi.fn().mockResolvedValue([]),
      updateTradeStatus: vi.fn().mockResolvedValue(true),
    };

    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getConnection: vi.fn().mockReturnValue({
        getSignatureStatuses: vi.fn().mockResolvedValue({
          value: [{ err: null, confirmationStatus: 'confirmed' }]
        })
      }),
      getParsedTransaction: vi.fn().mockResolvedValue({
        meta: { 
          err: null, 
          fee: 5000,
          preBalances: [2_000_000_000],
          postBalances: [1_950_000_000],
          preTokenBalances: [],
          postTokenBalances: [{ mint: 'token-A', owner: '1111', uiTokenAmount: { amount: '1000000', decimals: 6 } }]
        },
        transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => '1111' } }, 'token-A'] } }
      })
    };



    const worker: any = createReconcileWorker(mockTradeRepo, mockWalletService);
    await worker.processor({});

    expect(mockTradeRepo.updateTradeStatus).toHaveBeenCalledWith('trade-2', expect.objectContaining({
      status: 'OPEN',
      remaining_raw: 1000000,
      token_decimals: 6,
      sol_spent_lamports: 49995000
    }));
  });

  it('deducts remaining_raw correctly when token deficit is found (FIFO)', async () => {
    const mockTradeRepo: any = {
      getPendingTradesWithSignature: vi.fn().mockResolvedValue([]),
      getOpenTradesOrderedFIFO: vi.fn().mockResolvedValue([
        { id: 'trade-1', user_id: 111, token_mint: 'token-A', remaining_raw: 10 },
        { id: 'trade-2', user_id: 111, token_mint: 'token-A', remaining_raw: 20 },
      ]),
      updateTradeStatus: vi.fn().mockResolvedValue(true),
    };

    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '11111111111111111111111111111111' }),
      getTokenBalance: vi.fn().mockResolvedValue({ raw: 15n, decimals: 6, ui: 0.000015 }),
      getConnection: vi.fn().mockReturnValue({
        getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] })
      }),
    };

    const worker: any = createReconcileWorker(mockTradeRepo, mockWalletService);
    await worker.processor({});

    // Deficit is 15.
    // trade-1 has 10. deduct 10. remaining 0 -> CLOSED
    expect(mockTradeRepo.updateTradeStatus).toHaveBeenCalledWith('trade-1', expect.objectContaining({
      remaining_raw: 0,
      status: 'CLOSED'
    }));

    // Remaining deficit is 5.
    // trade-2 has 20. deduct 5. remaining 15.
    expect(mockTradeRepo.updateTradeStatus).toHaveBeenCalledWith('trade-2', expect.objectContaining({
      remaining_raw: 15,
      needs_attention: true
    }));
  });
});
