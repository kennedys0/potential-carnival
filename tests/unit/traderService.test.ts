import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TraderService } from '../../src/modules/trader/traderService';
import { LiveTradingDisabledError, KillSwitchActiveError } from '../../src/utils/errors';

vi.mock('../../src/config/env', () => ({
  getEnv: vi.fn(() => ({
    LIVE_TRADING_ENABLED: true,
  })),
}));

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/queue/connection', () => ({
  getRedisConnection: vi.fn(() => mockRedis),
}));

describe('TraderService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null); // Kill switch off by default
  });

  it('calculates dynamic slippage capped at maxSlippageBps', () => {
    const service = new TraderService({} as any);
    const slippage = service.calculateDynamicSlippage(100, 1.5, 300); // 100 + 1.5*120 = 280 <= 300
    expect(slippage).toBe(280);

    const capped = service.calculateDynamicSlippage(150, 2.5, 250); // 150 + 2.5*120 = 450 > 250
    expect(capped).toBe(250);
  });

  it('creates dry-run trade record in database for paper trading', async () => {
    const mockTradeRepo: any = {
      createTrade: vi.fn().mockImplementation((trade) => Promise.resolve({ id: 'trade-uuid', ...trade })),
    };
    const service = new TraderService(mockTradeRepo, {} as any, {} as any);

    const result = await service.executeOrder({
      userId: 111,
      tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenSymbol: 'USDC',
      solAmount: 0.5,
      currentPriceUsd: 1.0,
      isDryRun: true,
      source: 'MANUAL',
    });

    expect(result.is_dry_run).toBe(true);
    expect(result.token_mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(mockTradeRepo.createTrade).toHaveBeenCalled();
  });

  it('rejects live trade if SOL balance is insufficient', async () => {
    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getBalance: vi.fn().mockResolvedValue({ sol: 0.5 }), // only 0.5 SOL
    };
    const service = new TraderService({} as any, mockWalletService, {} as any);

    await expect(service.executeOrder({
      userId: 111,
      tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenSymbol: 'USDC',
      solAmount: 0.5, // trying to spend 0.5, but need 0.5 + 0.005
      currentPriceUsd: 1.0,
      isDryRun: false,
      source: 'MANUAL',
    })).rejects.toThrow('Saldo SOL tidak cukup');
  });

  it('executes live trade and returns tx_signature on success', async () => {
    const mockTradeRepo: any = {
      createTrade: vi.fn().mockImplementation((trade) => Promise.resolve({ id: 'trade-uuid', ...trade })),
      updateTradeStatus: vi.fn().mockResolvedValue(true),
    };
    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getBalance: vi.fn().mockResolvedValue({ sol: 1.0 }),
      signAndSendVersionedTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', signature: 'mock-tx-sig-123' }),
      getParsedTransaction: vi.fn().mockResolvedValue({
        meta: { fee: 5000, preBalances: [2_000_000_000], postBalances: [1_500_000_000] },
        transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => '1111' } }] } }
      }),
    };
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '10000000' }),
      getSwapTransaction: vi.fn().mockResolvedValue({ mockTx: true }),
    };

    const service = new TraderService(mockTradeRepo, mockWalletService, mockJupiterClient);

    const result = await service.executeOrder({
      userId: 111,
      tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenSymbol: 'USDC',
      solAmount: 0.5,
      currentPriceUsd: 1.0,
      isDryRun: false,
      source: 'MANUAL',
    });

    expect(mockJupiterClient.getQuote).toHaveBeenCalled();
    expect(mockJupiterClient.getSwapTransaction).toHaveBeenCalled();
    expect(mockWalletService.signAndSendVersionedTransaction).toHaveBeenCalled();
    expect(mockWalletService.getParsedTransaction).toHaveBeenCalledWith('mock-tx-sig-123');
    expect(result.tx_signature).toBe('mock-tx-sig-123');
    expect(result.is_dry_run).toBe(false);
    expect(result.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sol_spent_lamports).toBeDefined();
  });

  it('rejects BUY order if kill-switch is active', async () => {
    mockRedis.get.mockResolvedValue('1'); // Kill switch active
    
    const service = new TraderService({} as any, {} as any, {} as any);
    await expect(service.executeOrder({
      userId: 111,
      tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenSymbol: 'USDC',
      solAmount: 0.5,
      currentPriceUsd: 1.0,
      isDryRun: false,
      source: 'MANUAL',
    })).rejects.toThrow(KillSwitchActiveError);
  });

  it('allows SELL (closePosition) even if kill-switch is active', async () => {
    mockRedis.get.mockResolvedValue('1'); // Kill switch active
    
    const mockTradeRepo: any = {
      updateTradeStatus: vi.fn().mockResolvedValue(true),
    };
    const service = new TraderService(mockTradeRepo, {} as any, {} as any);
    
    // Test that closePosition doesn't throw KillSwitchActiveError
    await expect(service.closePosition({
      id: 'trade-uuid',
      user_id: 111,
      token_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      status: 'OPEN',
      is_dry_run: true,
      sol_amount: 0.5,
      token_amount: 10,
      entry_price_usd: 1.0,
    } as any, 1.5, 100)).resolves.not.toThrow();
  });

  it('keeps status OPEN/PARTIAL_EXIT on closePosition failure and increments exit_attempts (R3 Mutation)', async () => {
    const mockTradeRepo: any = {
      updateTradeStatus: vi.fn().mockResolvedValue(true),
    };
    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getTokenBalance: vi.fn().mockResolvedValue(10_000_000), // 10 tokens
      signAndSendVersionedTransaction: vi.fn().mockRejectedValue(new Error('RPC Timeout')),
    };
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '10000000' }),
      getSwapTransaction: vi.fn().mockResolvedValue({ mockTx: true }),
    };

    const service = new TraderService(mockTradeRepo, mockWalletService, mockJupiterClient);

    const trade = {
      id: 'trade-123',
      user_id: 111,
      token_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      status: 'OPEN',
      is_dry_run: false,
      sol_amount: 0.5,
      token_amount: 10,
      entry_price_usd: 1.0,
      exit_attempts: 1,
    };

    await expect(service.closePosition(trade as any, 1.5, 100)).rejects.toThrow('RPC Timeout');

    // It should have incremented exit_attempts to 2, and needs_attention should be false (since < 3)
    // Status MUST NOT be FAILED. It remains whatever it was (we don't pass status in this update).
    expect(mockTradeRepo.updateTradeStatus).toHaveBeenCalledWith('trade-123', expect.objectContaining({
      exit_attempts: 2,
    }));
    expect(mockTradeRepo.updateTradeStatus).toHaveBeenCalledWith('trade-123', expect.objectContaining({
      last_exit_error: 'RPC Timeout',
      needs_attention: false,
    }));
    
    // Check that it doesn't set status: 'FAILED' anywhere
    const failedCalls = mockTradeRepo.updateTradeStatus.mock.calls.filter((c: any) => c[1].status === 'FAILED');
    expect(failedCalls.length).toBe(0);
  });

  it('rejects live trade if LIVE_TRADING_ENABLED is false', async () => {
    const { getEnv } = await import('../../src/config/env');
    vi.mocked(getEnv).mockReturnValueOnce({ LIVE_TRADING_ENABLED: false } as any);
    
    const service = new TraderService({} as any, {} as any, {} as any);
    await expect(service.executeOrder({
      userId: 111,
      tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenSymbol: 'USDC',
      solAmount: 0.5,
      currentPriceUsd: 1.0,
      isDryRun: false, // Live trade
      source: 'MANUAL',
    })).rejects.toThrow(LiveTradingDisabledError);
  });
});
