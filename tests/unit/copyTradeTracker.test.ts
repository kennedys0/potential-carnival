import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyTradeTracker, extractVerifiedTargetBuy, isValidSolanaSignature } from '../../src/modules/copytrade/copyTradeTracker';
import { currencyService } from '../../src/utils/currencyService';
import bs58 from 'bs58';

const redis = { set: vi.fn(), get: vi.fn(), eval: vi.fn() };
vi.mock('../../src/queue/connection', () => ({ getRedisConnection: () => redis }));

vi.mock('../../src/utils/currencyService', () => ({
  currencyService: {
    fetchRates: vi.fn().mockResolvedValue(undefined),
    getUsdPerSol: vi.fn().mockReturnValue(200),
  },
}));

describe('CopyTradeTracker risk controls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('converts max_buy_usd with a fresh rate and reserves exposure before execution', async () => {
    const trader: any = {
      acquireBuyLock: vi.fn().mockResolvedValue(true),
      releaseBuyLock: vi.fn().mockResolvedValue(undefined),
      hasActiveTrade: vi.fn().mockResolvedValue(false),
      executeOrder: vi.fn().mockResolvedValue({ status: 'OPEN' }),
    };
    const reservation: any = {
      reserve: vi.fn().mockResolvedValue('reservation-1'),
      finish: vi.fn().mockResolvedValue(undefined),
      releaseIfUnbroadcast: vi.fn(),
    };
    const autopilotRepo: any = {
      getOrCreateConfig: vi.fn().mockResolvedValue({
        is_active: true,
        mode: 'PAPER',
        safety_params: { min_safety_score: 70, allowed_levels: ['SAFE'], min_liquidity_usd: 5_000 },
        sizing_params: { mode: 'FIXED_SOL', fixed_sol: 0.1, max_concurrent_positions: 3, min_reserve_sol: 0.01 },
        exit_params: { tp1_percent: 15, sl_percent: 8 },
      }),
    };
    const stateService: any = {
      getAutopilotState: vi.fn().mockResolvedValue({
        openPositionsCount: 0, availableBalanceSol: 1, heldMints: [], isCircuitBroken: false,
      }),
      checkCircuitBreaker: vi.fn().mockResolvedValue(false),
    };
    const botApi = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const tracker = new CopyTradeTracker(
      {} as any, {} as any, trader, {} as any, {} as any,
      autopilotRepo, reservation, stateService, botApi,
    );

    await (tracker as any).executeFollower(
      { user_id: 7, max_buy_usd: 10, target_wallet_address: '11111111111111111111111111111111' },
      'TokenMint111111111111111111111111111111111',
      'TOK',
      1,
      50_000,
      { score: 90, level: 'SAFE' },
      'source-signature',
    );

    expect(currencyService.getUsdPerSol).toHaveBeenCalled();
    expect(reservation.reserve).toHaveBeenCalledWith(expect.objectContaining({
      strategy: 'COPY_TRADE',
      amountSol: 0.05,
    }));
    expect(trader.executeOrder).toHaveBeenCalledWith(expect.objectContaining({
      solAmount: 0.05,
      strategy: 'COPY_TRADE',
      source: 'AUTOPILOT',
      copySourceSignature: 'source-signature',
      copyTargetWallet: '11111111111111111111111111111111',
    }));
    expect(reservation.finish).toHaveBeenCalledWith('reservation-1', 'COMPLETED');
  });

  it('rejects an already-held mint before reservation or execution', async () => {
    const trader: any = { executeOrder: vi.fn() };
    const reservation: any = { reserve: vi.fn() };
    const tracker = new CopyTradeTracker(
      {} as any, {} as any, trader, {} as any, {} as any,
      { getOrCreateConfig: vi.fn().mockResolvedValue({ is_active: true, safety_params: {}, sizing_params: {}, exit_params: {} }) } as any,
      reservation,
      {
        getAutopilotState: vi.fn().mockResolvedValue({ heldMints: ['MINT'], openPositionsCount: 1, availableBalanceSol: 1 }),
        checkCircuitBreaker: vi.fn().mockResolvedValue(false),
      } as any,
      { sendMessage: vi.fn() },
    );

    await expect((tracker as any).executeFollower(
      { user_id: 7, max_buy_usd: 10, target_wallet_address: '11111111111111111111111111111111' }, 'MINT', 'TOK', 1, 50_000,
      { score: 100, level: 'SAFE' }, 'source-signature',
    )).rejects.toThrow(/already held/);
    expect(reservation.reserve).not.toHaveBeenCalled();
    expect(trader.executeOrder).not.toHaveBeenCalled();
  });

  it('rejects execution when the follower autopilot master switch is inactive', async () => {
    const stateService = { getAutopilotState: vi.fn(), checkCircuitBreaker: vi.fn() };
    const trader = { executeOrder: vi.fn() };
    const tracker = new CopyTradeTracker(
      {} as any, {} as any, trader as any, {} as any, {} as any,
      { getOrCreateConfig: vi.fn().mockResolvedValue({ is_active: false }) } as any,
      {} as any, stateService as any, { sendMessage: vi.fn() },
    );

    await expect((tracker as any).executeFollower(
      { user_id: 7, max_buy_usd: 10, target_wallet_address: '11111111111111111111111111111111' },
      'MINT', 'TOK', 1, 50_000, { score: 100, level: 'SAFE' }, 'source-signature',
    )).rejects.toThrow(/autopilot is inactive/);
    expect(stateService.getAutopilotState).not.toHaveBeenCalled();
    expect(trader.executeOrder).not.toHaveBeenCalled();
  });
});

describe('copy-trade source transaction verification', () => {
  const target = '11111111111111111111111111111111';
  const tokenMint = 'TokenMint111111111111111111111111111111111';
  const wsolMint = 'So11111111111111111111111111111111111111112';

  it('accepts only a canonical 64-byte base58 transaction signature', () => {
    expect(isValidSolanaSignature(bs58.encode(Buffer.alloc(64, 1)))).toBe(true);
    expect(isValidSolanaSignature('source-signature')).toBe(false);
    expect(isValidSolanaSignature(bs58.encode(Buffer.alloc(63, 1)))).toBe(false);
  });

  function transaction(options: {
    signer?: boolean;
    preLamports?: number;
    postLamports?: number;
    fee?: number;
    preTokens?: Array<{ mint: string; amount: string }>;
    postTokens?: Array<{ mint: string; amount: string }>;
    err?: unknown;
  } = {}): any {
    const toBalances = (balances: Array<{ mint: string; amount: string }>) => balances.map((balance, accountIndex) => ({
      accountIndex,
      mint: balance.mint,
      owner: target,
      uiTokenAmount: { amount: balance.amount, decimals: 6, uiAmount: null, uiAmountString: balance.amount },
    }));
    return {
      transaction: {
        message: { accountKeys: [{ pubkey: { toBase58: () => target }, signer: options.signer ?? true }] },
      },
      meta: {
        err: options.err ?? null,
        fee: options.fee ?? 5_000,
        preBalances: [options.preLamports ?? 2_000_000_000],
        postBalances: [options.postLamports ?? 1_899_995_000],
        preTokenBalances: toBalances(options.preTokens ?? []),
        postTokenBalances: toBalances(options.postTokens ?? [{ mint: tokenMint, amount: '1000000' }]),
      },
    };
  }

  it('loads source evidence only after finalized status', async () => {
    const parsed = transaction();
    const connection: any = {
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [{ err: null, confirmationStatus: 'finalized' }],
      }),
      getParsedTransaction: vi.fn().mockResolvedValue(parsed),
    };
    const tracker = new CopyTradeTracker(
      connection, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any,
    );
    const signature = bs58.encode(Buffer.alloc(64, 1));

    await expect((tracker as any).waitForFinalizedSourceTransaction(signature)).resolves.toBe(parsed);
    expect(connection.getParsedTransaction).toHaveBeenCalledWith(signature, {
      maxSupportedTransactionVersion: 1,
      commitment: 'finalized',
    });
  });

  it('rejects a dust transfer when the watched wallet did not sign', () => {
    expect(extractVerifiedTargetBuy(transaction({ signer: false }), target)).toBeNull();
  });

  it('rejects a signed receive-only transaction with no SOL or WSOL spent', () => {
    expect(extractVerifiedTargetBuy(transaction({
      preLamports: 2_000_000_000,
      postLamports: 1_999_995_000,
    }), target)).toBeNull();
  });

  it('accepts one token bought with native SOL after excluding the network fee', () => {
    expect(extractVerifiedTargetBuy(transaction(), target)).toEqual({
      tokenMint,
      nativeSpendLamports: 100_000_000n,
      wrappedSolSpendRaw: 0n,
    });
  });

  it('accepts one token bought by spending wrapped SOL', () => {
    expect(extractVerifiedTargetBuy(transaction({
      preLamports: 2_000_000_000,
      postLamports: 1_999_995_000,
      preTokens: [{ mint: wsolMint, amount: '100000000' }],
      postTokens: [
        { mint: wsolMint, amount: '0' },
        { mint: tokenMint, amount: '1000000' },
      ],
    }), target)).toEqual({
      tokenMint,
      nativeSpendLamports: 0n,
      wrappedSolSpendRaw: 100_000_000n,
    });
  });

  it('rejects failed or ambiguous multi-asset transactions', () => {
    expect(extractVerifiedTargetBuy(transaction({ err: { InstructionError: [1, 'Custom'] } }), target)).toBeNull();
    expect(extractVerifiedTargetBuy(transaction({
      postTokens: [
        { mint: tokenMint, amount: '1000000' },
        { mint: 'OtherMint111111111111111111111111111111111', amount: '1' },
      ],
    }), target)).toBeNull();
  });
});
