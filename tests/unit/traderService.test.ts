import { describe, it, expect, vi } from 'vitest';
import { TraderService } from '../../src/modules/trader/traderService';

describe('TraderService', () => {
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
    };
    const mockWalletService: any = {
      getOrCreateWallet: vi.fn().mockResolvedValue({ publicKey: '1111' }),
      getBalance: vi.fn().mockResolvedValue({ sol: 1.0 }),
      signAndSendVersionedTransaction: vi.fn().mockResolvedValue('mock-tx-sig-123'),
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
    expect(result.tx_signature).toBe('mock-tx-sig-123');
    expect(result.is_dry_run).toBe(false);
  });
});
