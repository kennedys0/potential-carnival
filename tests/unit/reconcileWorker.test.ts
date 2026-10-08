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
      getInflightTradesWithSignature: vi.fn().mockResolvedValue([
        { id: 'trade-1', pending_signature: 'sig-1' }
      ]),
      getReservedTradesWithoutSignature: vi.fn().mockResolvedValue([]),
      getOpenTradesOrderedFIFO: vi.fn().mockResolvedValue([]),
      updateTradeStatus: vi.fn().mockResolvedValue(true),
      getAllPendingExitAttempts: vi.fn().mockResolvedValue([]),
    };

    const mockWalletService: any = {
      getConnection: vi.fn().mockReturnValue({
        getSignatureStatuses: vi.fn().mockResolvedValue({
          value: [{ err: { InstructionError: [0, 'error'] } }]
        })
      }),
      walletRepo: { getPendingWithdrawals: vi.fn().mockResolvedValue([]) }
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
      getInflightTradesWithSignature: vi.fn().mockResolvedValue([
        { id: 'trade-2', pending_signature: 'sig-2', user_id: 1, token_mint: 'token-A' }
      ]),
      getReservedTradesWithoutSignature: vi.fn().mockResolvedValue([]),
      getOpenTradesOrderedFIFO: vi.fn().mockResolvedValue([]),
      updateTradeStatus: vi.fn().mockResolvedValue(true),
      atomicReconcileEntry: vi.fn().mockResolvedValue(true),
      getAllPendingExitAttempts: vi.fn().mockResolvedValue([]),
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
      }),
      walletRepo: { getPendingWithdrawals: vi.fn().mockResolvedValue([]) }
    };



    const worker: any = createReconcileWorker(mockTradeRepo, mockWalletService);
    await worker.processor({});

    expect(mockTradeRepo.atomicReconcileEntry).toHaveBeenCalledWith('trade-2', expect.objectContaining({
      status: 'OPEN',
      remaining_raw: '1000000',
      token_decimals: 6,
      sol_spent_lamports: '49995000'
    }));
  });

  it('deducts remaining_raw correctly when token deficit is found (FIFO)', async () => {
    const mockTradeRepo: any = {
      getInflightTradesWithSignature: vi.fn().mockResolvedValue([]),
      getReservedTradesWithoutSignature: vi.fn().mockResolvedValue([]),
      getOpenTradesOrderedFIFO: vi.fn().mockResolvedValue([
        { id: 'trade-1', user_id: 111, token_mint: 'token-A', remaining_raw: 10 },
        { id: 'trade-2', user_id: 111, token_mint: 'token-A', remaining_raw: 20 },
      ]),
      updateTradeStatus: vi.fn().mockResolvedValue(true),
      getAllPendingExitAttempts: vi.fn().mockResolvedValue([]),
      db: {
        from: vi.fn().mockReturnValue({
          insert: vi.fn().mockResolvedValue({ error: null })
        })
      }
    };

    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '11111111111111111111111111111111' }),
      getTokenBalance: vi.fn().mockResolvedValue({ raw: 15n, decimals: 6, ui: 0.000015 }),
      getConnection: vi.fn().mockReturnValue({
        getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] })
      }),
      walletRepo: { getPendingWithdrawals: vi.fn().mockResolvedValue([]) }
    };

    const worker: any = createReconcileWorker(mockTradeRepo, mockWalletService);
    await worker.processor({});

    // Deficit is 15. Expected to record inventory discrepancy, NOT modify trade directly
    expect(mockTradeRepo.db.from).toHaveBeenCalledWith('inventory_discrepancies');
  });
  it('reconciles PENDING exit attempt correctly after worker crash', async () => {
    const mockTradeRepo: any = {
      getInflightTradesWithSignature: vi.fn().mockResolvedValue([]),
      getReservedTradesWithoutSignature: vi.fn().mockResolvedValue([]),
      getOpenTradesOrderedFIFO: vi.fn().mockResolvedValue([]),
      updateTradeStatus: vi.fn().mockResolvedValue(true),
      getAllPendingExitAttempts: vi.fn().mockResolvedValue([
        { id: 'exit-1', trade_id: 'trade-1', tx_signature: 'sig-1', status: 'PENDING', percentage: 100, created_at: new Date(Date.now() - 5000).toISOString() }
      ]),
      updateExitAttempt: vi.fn().mockResolvedValue(true),
      getTradeById: vi.fn().mockResolvedValue({
         id: 'trade-1', user_id: 111, remaining_raw: '1000000', sol_spent_lamports: '10000000', token_amount_raw: '1000000', token_mint: 'token-A'
      }),
      atomicReconcileExit: vi.fn().mockResolvedValue(true),
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
          preBalances: [1_000_000_000],
          postBalances: [1_050_000_000],
          preTokenBalances: [{ mint: 'token-A', owner: '1111', uiTokenAmount: { amount: '1000000', decimals: 6 } }],
          postTokenBalances: [{ mint: 'token-A', owner: '1111', uiTokenAmount: { amount: '0', decimals: 6 } }]
        },
        transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => '1111' } }, 'token-A'] } }
      }),
      walletRepo: { getPendingWithdrawals: vi.fn().mockResolvedValue([]) }
    };

    const worker: any = createReconcileWorker(mockTradeRepo, mockWalletService);
    await worker.processor({});

    expect(mockTradeRepo.atomicReconcileExit).toHaveBeenCalledWith('trade-1', 'exit-1', expect.objectContaining({
      tx_signature: 'sig-1',
      token_delta_raw: '1000000',
    }));
  });
});
