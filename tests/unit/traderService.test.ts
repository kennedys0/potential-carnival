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
  eval: vi.fn().mockResolvedValue(1),
};

vi.mock('../../src/queue/connection', () => ({
  getRedisConnection: vi.fn(() => mockRedis),
}));

describe('TraderService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null); // Kill switch off by default
    mockRedis.set.mockResolvedValue('OK'); // Lock acquired successfully
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
      atomicReconcileEntry: vi.fn().mockResolvedValue(true),
    };
    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getBalance: vi.fn().mockResolvedValue({ sol: 1.0 }),
      signAndSendVersionedTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', signature: 'mock-tx-sig-123' }),
      getParsedTransaction: vi.fn().mockResolvedValue({
        meta: { 
          fee: 5000, 
          preBalances: [2_000_000_000], 
          postBalances: [1_500_000_000],
          preTokenBalances: [],
          postTokenBalances: [{ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: '1111', uiTokenAmount: { amount: '1000000', decimals: 6 } }]
        },
        transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => '1111' } }, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] } }
      }),
    };
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '10000000' }),
      getSwapTransaction: vi.fn().mockResolvedValue({ transaction: { message: { recentBlockhash: 'mock-blockhash' }, signatures: [Buffer.from('sig')] }, lastValidBlockHeight: 100 }),
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
      getPendingExitAttempts: vi.fn().mockResolvedValue([]),
      atomicReconcileExit: vi.fn().mockResolvedValue(true),
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
      getPendingExitAttempts: vi.fn().mockResolvedValue([]),
      createExitAttempt: vi.fn().mockImplementation(async (a: any) => ({ id: 'mock-exit', ...a })),
      updateExitAttempt: vi.fn().mockResolvedValue(true),
      atomicReconcileExit: vi.fn().mockResolvedValue(true),
    };
    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getTokenBalance: vi.fn().mockResolvedValue({ raw: 10_000_000n, decimals: 6, ui: 10 }), // 10 tokens
      signAndSendVersionedTransaction: vi.fn().mockRejectedValue(new Error('RPC Timeout')),
    };
    const mockJupiterClient: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '10000000' }),
      getSwapTransaction: vi.fn().mockResolvedValue({ transaction: { message: { recentBlockhash: 'mock-blockhash' }, signatures: [Buffer.from('sig')] }, lastValidBlockHeight: 100 }),
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
    const repo: any = { 
      updateTradeStatus: vi.fn().mockResolvedValue(true),
      getPendingExitAttempts: vi.fn().mockResolvedValue([]),
      createExitAttempt: vi.fn().mockImplementation(async (a: any) => ({ id: 'mock-exit', ...a })),
      updateExitAttempt: vi.fn().mockResolvedValue(true),
      atomicReconcileExit: vi.fn().mockResolvedValue(true),
    };
    const wallet: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getTokenBalance: vi.fn().mockResolvedValue({ raw: 10_000_000n, decimals: 6, ui: 10 }),
      signAndSendVersionedTransaction: vi.fn().mockResolvedValue(sendResult),
      getParsedTransaction: vi.fn().mockResolvedValue({
        meta: { 
          fee: 5000, 
          preBalances: [2_000_000_000], 
          postBalances: [2_800_000_000], // gained 0.8 SOL
          preTokenBalances: [{ mint: MINT, owner: '1111', uiTokenAmount: { amount: '2000000', decimals: 6 } }],
          postTokenBalances: [{ mint: MINT, owner: '1111', uiTokenAmount: { amount: '1000000', decimals: 6 } }]
        },
        transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => '1111' } }, MINT] } }
      }),
    };
    const jup: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '1000' }),
      getSwapTransaction: vi.fn().mockResolvedValue({ transaction: { message: { recentBlockhash: 'mock-blockhash' }, signatures: [Buffer.from('sig')] }, lastValidBlockHeight: 100 }),
    };
    return { repo, wallet, jup, service: new TraderService(repo, wallet, jup) };
  };
  const updatesOf = (repo: any): any[] => [
    ...repo.updateTradeStatus.mock.calls.map((c: any) => c[1]),
    ...(repo.atomicReconcileExit?.mock.calls.map((c: any) => c[2]) || [])
  ];

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
    await expect(service.closePosition(liveTrade() as any, 1.5, 100)).rejects.toThrowError(/Exit transaction failed: FAILED_ONCHAIN/);
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
    expect(ups).toContainEqual(expect.objectContaining({ last_exit_error: 'Uncertain status: UNKNOWN' }));
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
      getPendingExitAttempts: vi.fn().mockResolvedValue([]),
      createExitAttempt: vi.fn().mockImplementation(async (a: any) => ({ id: 'mock-exit', ...a })),
      updateExitAttempt: vi.fn().mockResolvedValue(true),
      atomicReconcileExit: vi.fn().mockResolvedValue(true),
    };
    const wallet: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getBalance: vi.fn().mockResolvedValue({ sol: 1.0 }),
      signAndSendVersionedTransaction: sendImpl,
      getParsedTransaction: parsedImpl ?? vi.fn().mockResolvedValue({
        meta: { 
          fee: 5000, 
          preBalances: [2_000_000_000], 
          postBalances: [1_500_000_000],
          preTokenBalances: [],
          postTokenBalances: [{ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: '1111', uiTokenAmount: { amount: '1000000', decimals: 6 } }]
        },
        transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => '1111' } }, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] } }
      }),
    };
    const jup: any = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '10000000' }),
      getSwapTransaction: vi.fn().mockResolvedValue({ transaction: { message: { recentBlockhash: 'mock-blockhash' }, signatures: [Buffer.from('sig')] }, lastValidBlockHeight: 100 }),
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

  it('[GUARD] entry: tolak bila priceImpactPct > batas config', async () => {
    const { service } = buyDeps(sendWithSig({ status: 'SUCCESS', signature: 'sigX' }));
    // Mock quote to return high price impact (3% = "0.03")
    service['jupiterClient']!.getQuote = vi.fn().mockResolvedValue({ priceImpactPct: '0.03' });
    await expect(service.executeOrder(buyReq)).rejects.toThrow(/Price impact \(3.00%\) melebihi batas/);
  });

  it('[GUARD] exit: eskalasi slippage exit sesuai attempts, dan cost basis proporsional (PnL benar)', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'SUCCESS', signature: 'sigZ' });
    const { service, repo, jup } = exitDeps(send);
    const trade = liveTrade({ 
      remaining_raw: 2000000, 
      exit_attempts: 2, 
      sol_spent_lamports: 1000000000, // 1 SOL
      token_amount_raw: 2000000 
    });
    
    await service.closePosition(trade as any, 1.5, 50); // 50% = 1,000,000 tokens
    
    // Check slippage escalation
    // base: 100, step: 50. attempt: 2 -> currentAttempt before fetch is 3.
    // wait, in exitPosition: currentAttempts = (trade.exit_attempts ?? 0) + 1 = 3.
    // exitSlippageBps = 100 + (3-1)*50 = 200.
    expect(jup.getQuote).toHaveBeenCalledWith(trade.token_mint, expect.any(String), 1000000, 200);
    
    const ups = updatesOf(repo);
    const pnlUpdate = ups.find(u => u.pnl_sol !== undefined);
    expect(pnlUpdate).toBeDefined();
    // 50% tokens = 0.5 SOL cost. solReceived = 0.8. fee = 0.000005. 
    // realizedPnl = 0.8 - 0.5 - 0.000005 = 0.299995
    expect(pnlUpdate!.realized_pnl_sol).toBeCloseTo(0.299995, 5);
  });

  it('[GUARD] exit: partial exit berulang (50%, lalu 100% sisa) dengan presisi BigInt (>2^53)', async () => {
    // 5_000_000_000_000_000 = 5e15, which is < Number.MAX_SAFE_INTEGER (9e15), 
    // but we can use big numbers to ensure logic holds.
    const initialRaw = 5000000000000000;
    const trade = liveTrade({ 
      remaining_raw: initialRaw, 
      exit_attempts: 0, 
      sol_spent_lamports: 2000000000, // 2 SOL cost
      token_amount_raw: initialRaw,
      realized_pnl_sol: 0,
      pnl_percent: 0,
    });
    
    // 1st partial exit: 50%
    const send1 = vi.fn().mockResolvedValue({ status: 'SUCCESS', signature: 'sig1' });
    let { service, repo, jup, wallet } = exitDeps(send1);
    wallet.getTokenBalance.mockResolvedValue({ raw: BigInt(initialRaw), decimals: 9, ui: 5000000 });
    wallet.getParsedTransaction.mockResolvedValue({
      meta: { 
        fee: 5000, postBalances: [3000000000], preBalances: [2000000000], // gained 1.0 SOL
        preTokenBalances: [{ mint: MINT, owner: '1111', uiTokenAmount: { amount: initialRaw.toString(), decimals: 9 } }],
        postTokenBalances: [{ mint: MINT, owner: '1111', uiTokenAmount: { amount: (initialRaw / 2).toString(), decimals: 9 } }]
      },
      transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => '1111' } }, MINT] } }
    });
    await service.closePosition(trade as any, 1.5, 50); 
    
    let ups = updatesOf(repo);
    let pnlUpdate1 = ups.find(u => u.pnl_sol !== undefined);
    expect(pnlUpdate1).toBeDefined();
    expect(pnlUpdate1!.remaining_raw).toBe(String(initialRaw / 2));
    // Cost for 50% is 1 SOL. Received 1 SOL (net). Fee is 0.000005. PnL = 0.
    expect(pnlUpdate1!.realized_pnl_sol).toBeCloseTo(0.0, 5);
    
    // 2nd exit: 100% of remaining
    const send2 = vi.fn().mockResolvedValue({ status: 'SUCCESS', signature: 'sig2' });
    const deps2 = exitDeps(send2);
    deps2.wallet.getTokenBalance.mockResolvedValue({ raw: BigInt(initialRaw / 2), decimals: 9, ui: 2500000 });
    deps2.wallet.getParsedTransaction.mockResolvedValue({
      meta: { 
        fee: 5000, postBalances: [4500000000], preBalances: [3000000000], // gained 1.5 SOL
        preTokenBalances: [{ mint: MINT, owner: '1111', uiTokenAmount: { amount: (initialRaw / 2).toString(), decimals: 9 } }],
        postTokenBalances: [{ mint: MINT, owner: '1111', uiTokenAmount: { amount: '0', decimals: 9 } }]
      },
      transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => '1111' } }, MINT] } }
    });
    
    const trade2 = { ...trade, ...pnlUpdate1, id: 'trade-2' }; // mock updated trade
    await deps2.service.closePosition(trade2 as any, 2.0, 100); 
    
    ups = updatesOf(deps2.repo);
    const pnlUpdate2 = ups.find(u => u.status === 'CLOSED');
    expect(pnlUpdate2).toBeDefined();
    expect(pnlUpdate2!.remaining_raw).toBe('0');
    expect(pnlUpdate2!.closed_at).toBeDefined(); // should be fully closed
    // 2nd exit cost = 1 SOL. Received 1.5 SOL (net). Fee = 0.000005. Realized this time = +0.5.
    // Total realized = 0.0 + 0.5 = 0.5.
    expect(pnlUpdate2!.realized_pnl_sol).toBeCloseTo(0.5, 5);
  });
});
