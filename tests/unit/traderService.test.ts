import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TraderService } from '../../src/modules/trader/traderService';
import { LiveTradingDisabledError, KillSwitchActiveError } from '../../src/utils/errors';
import { currencyService } from '../../src/utils/currencyService';
import { getEnv } from '../../src/config/env';

vi.mock('../../src/config/env', () => ({
  getEnv: vi.fn(() => ({
    LIVE_TRADING_ENABLED: true,
  })),
}));

// Kurs SOL/USD dimock supaya test tidak memanggil jaringan (default 150 hanya nilai test, bukan nilai kode produksi).
vi.mock('../../src/utils/currencyService', () => ({
  currencyService: {
    fetchRates: vi.fn().mockResolvedValue(undefined),
    getUsdPerSol: vi.fn(() => 150),
  },
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
      remaining_raw: 10_000_000,
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

  // ====================== GUARD TESTS (round 4 patch) ======================
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('paper: jumlah token memakai kurs SOL/USD nyata, bukan angka hardcoded', async () => {
    vi.mocked(currencyService.getUsdPerSol).mockReturnValueOnce(200);
    const mockTradeRepo: any = { createTrade: vi.fn().mockImplementation((t) => Promise.resolve({ id: 'p1', ...t })) };
    const service = new TraderService(mockTradeRepo, {} as any, {} as any);
    const result = await service.executeOrder({
      userId: 1, tokenMint: MINT, tokenSymbol: 'T', solAmount: 1, currentPriceUsd: 2, isDryRun: true, source: 'MANUAL',
    });
    expect(result.token_amount).toBe(100); // 1 SOL * $200 / $2
  });

  it('paper: ditolak (tanpa membuat trade) bila kurs SOL/USD tidak tersedia', async () => {
    vi.mocked(currencyService.getUsdPerSol).mockReturnValueOnce(null);
    const mockTradeRepo: any = { createTrade: vi.fn() };
    const service = new TraderService(mockTradeRepo, {} as any, {} as any);
    await expect(service.executeOrder({
      userId: 1, tokenMint: MINT, tokenSymbol: 'T', solAmount: 1, currentPriceUsd: 2, isDryRun: true, source: 'MANUAL',
    })).rejects.toThrow(/Kurs SOL\/USD tidak tersedia/);
    expect(mockTradeRepo.createTrade).not.toHaveBeenCalled();
  });

  const liveTrade = (over: any = {}) => ({
    id: 'trade-live', user_id: 111, token_mint: MINT, status: 'OPEN', is_dry_run: false,
    sol_amount: 0.5, token_amount: 10, entry_price_usd: 1.0,
    token_amount_raw: 10_000_000, remaining_raw: 10_000_000, exit_attempts: 0, ...over,
  });
  const exitDeps = (sendResult: any) => {
    const repo: any = { updateTradeStatus: vi.fn().mockResolvedValue(true) };
    const wallet: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getTokenBalance: vi.fn().mockResolvedValue(10_000_000),
      signAndSendVersionedTransaction: vi.fn().mockResolvedValue(sendResult),
    };
    const jup: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '1000' }),
      getSwapTransaction: vi.fn().mockResolvedValue({ tx: true }),
    };
    return { repo, wallet, service: new TraderService(repo, wallet, jup) };
  };
  const updatesOf = (repo: any): any[] => repo.updateTradeStatus.mock.calls.map((c: any) => c[1]);

  it('R2: exit LIVE tetap berjalan saat LIVE_TRADING_ENABLED=false DAN kill-switch aktif', async () => {
    vi.mocked(getEnv).mockReturnValue({ LIVE_TRADING_ENABLED: false } as any);
    mockRedis.get.mockResolvedValue('1');
    try {
      const { service, wallet } = exitDeps({ status: 'UNKNOWN', signature: 'sigX' });
      await expect(service.closePosition(liveTrade() as any, 1.5, 100)).resolves.toBeUndefined();
      expect(wallet.signAndSendVersionedTransaction).toHaveBeenCalled(); // benar-benar mencoba menjual
    } finally {
      vi.mocked(getEnv).mockReturnValue({ LIVE_TRADING_ENABLED: true } as any);
    }
  });

  it('R3: exit FAILED_ONCHAIN -> posisi TIDAK jadi FAILED, exit_attempts naik', async () => {
    const { service, repo } = exitDeps({ status: 'FAILED_ONCHAIN', signature: 's', err: { InstructionError: [0, 'Custom'] } });
    await expect(service.closePosition(liveTrade() as any, 1.5, 100)).rejects.toThrow('Exit transaction failed on-chain');
    const ups = updatesOf(repo);
    expect(ups.some((u) => u.status === 'FAILED')).toBe(false);
    expect(ups).toContainEqual(expect.objectContaining({ exit_attempts: 1 }));
    expect(ups).toContainEqual(expect.objectContaining({ needs_attention: false }));
  });

  it('R3: exit UNKNOWN -> posisi tetap OPEN (tanpa FAILED) menunggu rekonsiliasi', async () => {
    const { service, repo } = exitDeps({ status: 'UNKNOWN', signature: 's' });
    await expect(service.closePosition(liveTrade() as any, 1.5, 100)).resolves.toBeUndefined();
    const ups = updatesOf(repo);
    expect(ups.some((u) => u.status === 'FAILED')).toBe(false);
    expect(ups).toContainEqual(expect.objectContaining({ last_exit_error: 'Unknown status' }));
  });

  it('R3: percobaan exit ke-3 yang gagal menyalakan needs_attention', async () => {
    const { service, repo } = exitDeps({ status: 'FAILED_ONCHAIN', signature: 's', err: 'x' });
    await expect(service.closePosition(liveTrade({ exit_attempts: 2 }) as any, 1.5, 100)).rejects.toThrow();
    expect(updatesOf(repo)).toContainEqual(expect.objectContaining({ needs_attention: true }));
  });

  // WalletService asli memanggil callback onSignature SEBELUM mengembalikan hasil; mock harus meniru alur itu,
  // kalau tidak, blok catch menandai FAILED lewat jalur lain dan menutupi bug (ketahuan oleh mutation-check B2).
  const sendWithSig = (result: any) =>
    vi.fn().mockImplementation(async (_u: number, _tx: any, onSig: (s: string) => Promise<void>) => {
      await onSig(result.signature);
      return result;
    });

  const buyReq = { userId: 111, tokenMint: MINT, tokenSymbol: 'USDC', solAmount: 0.5, currentPriceUsd: 1.0, isDryRun: false, source: 'MANUAL' as const };
  const buyDeps = (sendImpl: any, parsedImpl?: any) => {
    const repo: any = {
      createTrade: vi.fn().mockImplementation((t) => Promise.resolve({ id: 'buy-1', ...t })),
      updateTradeStatus: vi.fn().mockResolvedValue(true),
    };
    const wallet: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getBalance: vi.fn().mockResolvedValue({ sol: 1.0 }),
      signAndSendVersionedTransaction: sendImpl,
      getParsedTransaction: parsedImpl ?? vi.fn().mockResolvedValue(null),
    };
    const jup: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '10000000' }),
      getSwapTransaction: vi.fn().mockResolvedValue({ tx: true }),
    };
    return { repo, wallet, service: new TraderService(repo, wallet, jup) };
  };

  it('beli: FAILED_ONCHAIN -> trade ditandai FAILED (pasti tidak ada token)', async () => {
    const { service, repo } = buyDeps(sendWithSig({ status: 'FAILED_ONCHAIN', signature: 's', err: { InstructionError: [0, 'Custom'] } }));
    await expect(service.executeOrder(buyReq)).rejects.toThrow('On-chain transaction failed');
    expect(updatesOf(repo)).toContainEqual(expect.objectContaining({ status: 'FAILED' }));
  });

  it('beli: UNKNOWN -> trade tetap PENDING (jangan FAILED, jangan OPEN) untuk rekonsiliasi', async () => {
    const { service, repo } = buyDeps(sendWithSig({ status: 'UNKNOWN', signature: 's' }));
    const result = await service.executeOrder(buyReq);
    expect(result.status).toBe('PENDING');
    const ups = updatesOf(repo);
    expect(ups.some((u) => u.status === 'FAILED' || u.status === 'OPEN')).toBe(false);
  });

  it('beli: error SEBELUM tx terkirim -> FAILED (aman karena tidak ada signature)', async () => {
    const { service, repo } = buyDeps(vi.fn().mockRejectedValue(new Error('boom before send')));
    await expect(service.executeOrder(buyReq)).rejects.toThrow('boom before send');
    expect(updatesOf(repo)).toContainEqual(expect.objectContaining({ status: 'FAILED' }));
  });

  it('beli: error SETELAH signature diketahui -> JANGAN FAILED (tx mungkin sudah masuk, token ada di wallet)', async () => {
    const send = vi.fn().mockImplementation(async (_u: number, _tx: any, onSig: (s: string) => Promise<void>) => {
      await onSig('sigY');
      return { status: 'SUCCESS', signature: 'sigY' };
    });
    const { service, repo } = buyDeps(send, vi.fn().mockRejectedValue(new Error('rpc down')));
    await expect(service.executeOrder(buyReq)).rejects.toThrow('rpc down');
    const ups = updatesOf(repo);
    expect(ups).toContainEqual(expect.objectContaining({ pending_signature: 'sigY' }));
    expect(ups.some((u) => u.status === 'FAILED')).toBe(false);
  });
});
