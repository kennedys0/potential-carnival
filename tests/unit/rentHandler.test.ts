import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleClaimRent } from '../../src/modules/telegram/handlers/rentHandler';
import { handleReportCommand } from '../../src/modules/telegram/handlers/reportHandler';
import { currencyService } from '../../src/utils/currencyService';

vi.mock('../../src/queue/connection', () => {
  const store = new Map<string, string>();
  return {
    getRedisConnection: vi.fn(() => ({
      get: vi.fn(async (key: string) => store.get(key) || null),
      set: vi.fn(async (key: string, val: string) => {
        store.set(key, val);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => {
        store.delete(key);
        return 1;
      }),
    })),
  };
});

describe('Rent Handler & Claim Rent Feature', () => {
  beforeEach(() => {
    vi.spyOn(currencyService, 'fetchRates').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleClaimRent', () => {
    it('notifies user when no empty token accounts can be claimed', async () => {
      const mockCtx: any = {
        from: { id: 999 },
        reply: vi.fn().mockResolvedValue(true),
        callbackQuery: null,
      };

      const mockWalletService: any = {
        getClaimableRent: vi.fn().mockResolvedValue({
          emptyAccountsCount: 0,
          claimableLamports: 0,
          claimableSol: 0,
          accounts: [],
        }),
      };

      const mockTradeRepo: any = {
        getTradesByStatuses: vi.fn().mockResolvedValue([]),
      };

      await handleClaimRent(mockCtx, mockWalletService, mockTradeRepo);

      expect(mockCtx.reply).toHaveBeenCalled();
      const text = mockCtx.reply.mock.calls[0][0];
      expect(text).toContain('Tidak Ada Rent Fee Yang Dapat Diklaim');
    });

    it('successfully closes empty accounts and returns reclaimed SOL message', async () => {
      const mockCtx: any = {
        from: { id: 999 },
        reply: vi.fn().mockResolvedValue(true),
        callbackQuery: null,
      };

      const mockWalletService: any = {
        getClaimableRent: vi.fn().mockResolvedValue({
          emptyAccountsCount: 2,
          claimableLamports: 4078560,
          claimableSol: 0.00407856,
          accounts: [
            { pubkey: 'TokenAcc1', mint: 'Mint1', lamports: 2039280, programId: 'TokenProgram' },
            { pubkey: 'TokenAcc2', mint: 'Mint2', lamports: 2039280, programId: 'TokenProgram' },
          ],
        }),
        claimRent: vi.fn().mockResolvedValue({
          success: true,
          accountsClosed: 2,
          reclaimedLamports: 4078560,
          reclaimedSol: 0.00407856,
          signatures: ['txSig123'],
          message: 'Berhasil menutup 2 akun token kosong!',
        }),
      };

      const mockTradeRepo: any = {
        getTradesByStatuses: vi.fn().mockResolvedValue([]),
      };

      await handleClaimRent(mockCtx, mockWalletService, mockTradeRepo);

      expect(mockWalletService.claimRent).toHaveBeenCalled();
      const lastCall = mockCtx.reply.mock.calls[mockCtx.reply.mock.calls.length - 1];
      const text = lastCall[0];
      expect(text).toContain('Klaim Rent Fee Berhasil');
      expect(text).toContain('2 Token Account');
      expect(text).toContain('0.0041 SOL');
      expect(text).toContain('txSig123');
    });

    it('handles claim failure properly and reports error message', async () => {
      const mockCtx: any = {
        from: { id: 999 },
        reply: vi.fn().mockResolvedValue(true),
        callbackQuery: null,
      };

      const mockWalletService: any = {
        getClaimableRent: vi.fn().mockResolvedValue({
          emptyAccountsCount: 1,
          claimableLamports: 2039280,
          claimableSol: 0.00203928,
          accounts: [{ pubkey: 'Acc1', mint: 'M1', lamports: 2039280, programId: 'Prog' }],
        }),
        claimRent: vi.fn().mockResolvedValue({
          success: false,
          accountsClosed: 0,
          reclaimedLamports: 0,
          reclaimedSol: 0,
          signatures: [],
          message: 'Saldo SOL tidak mencukupi untuk biaya gas transaksi',
        }),
      };

      const mockTradeRepo: any = {
        getTradesByStatuses: vi.fn().mockResolvedValue([]),
      };

      await handleClaimRent(mockCtx, mockWalletService, mockTradeRepo);

      const lastCall = mockCtx.reply.mock.calls[mockCtx.reply.mock.calls.length - 1];
      const text = lastCall[0];
      expect(text).toContain('Gagal Mengklaim Rent Fee');
      expect(text).toContain('Saldo SOL tidak mencukupi');
    });
  });

  describe('handleReportCommand with claimable rent', () => {
    it('shows claimable rent fee recovery and claim button in daily report', async () => {
      const mockCtx: any = {
        from: { id: 888 },
        reply: vi.fn().mockResolvedValue(true),
      };

      const mockTradeRepo: any = {
        getClosedTradesToday: vi.fn().mockResolvedValue([]),
        getOpenTradesByUserId: vi.fn().mockResolvedValue([]),
      };

      const mockWalletService: any = {
        getClaimableRent: vi.fn().mockResolvedValue({
          emptyAccountsCount: 4,
          claimableLamports: 8157120,
          claimableSol: 0.00815712,
          accounts: [],
        }),
      };

      await handleReportCommand(mockCtx, mockTradeRepo, mockWalletService);

      expect(mockCtx.reply).toHaveBeenCalled();
      const text = mockCtx.reply.mock.calls[0][0];
      expect(text).toContain('Rent Fee Recovery');
      expect(text).toContain('4 Akun Kosong');
      expect(text).toContain('0.0082 SOL');

      const replyOptions = mockCtx.reply.mock.calls[0][1];
      const keyboardText = JSON.stringify(replyOptions.reply_markup);
      expect(keyboardText).toContain('claim_rent');
    });
  });
});
