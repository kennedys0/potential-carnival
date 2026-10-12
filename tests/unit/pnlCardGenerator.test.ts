import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PnlCardGenerator, PnlCardData } from '../../src/modules/telegram/services/pnlCardGenerator';
import { handlePnlCard } from '../../src/modules/telegram/handlers/pnlCardHandler';
import { currencyService } from '../../src/utils/currencyService';

describe('PnL Card Generator & Handler', () => {
  beforeEach(() => {
    vi.spyOn(currencyService, 'fetchRates').mockResolvedValue(undefined);
    vi.spyOn(currencyService, 'solToIdr').mockReturnValue(1500000);
    vi.spyOn(currencyService, 'formatIdr').mockReturnValue('Rp 1.500.000');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('PnlCardGenerator', () => {
    it('generates SVG with profit theme correctly', () => {
      const data: PnlCardData = {
        tokenSymbol: 'BONK',
        tokenMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        isProfit: true,
        pnlPercent: 125.5,
        pnlSol: 0.6275,
        pnlIdrText: 'Rp 1.500.000',
        entryPriceUsd: 0.00002,
        currentPriceUsd: 0.000045,
        solAmount: 0.5,
        isDryRun: false,
        strategy: 'SNIPER',
        status: 'OPEN',
      };

      const svg = PnlCardGenerator.generateCardSvg(data);
      expect(svg).toContain('<svg');
      expect(svg).toContain('BONK');
      expect(svg).toContain('+125.50%');
      expect(svg).toContain('+0.6275 SOL');
      expect(svg).toContain('#00FFA3'); // Neon emerald for profit
      expect(svg).toContain('LIVE TRADING');
      expect(svg).toContain('SNIPER');
      expect(svg).toContain('2.25x'); // Multiplier
    });

    it('generates SVG with loss theme correctly', () => {
      const data: PnlCardData = {
        tokenSymbol: 'WIF',
        tokenMint: 'EKpQGSJtjMFqKZ9KQanrWNkBJYwWq1x2s5j8B7YaB1pP',
        isProfit: false,
        pnlPercent: -15.4,
        pnlSol: -0.077,
        entryPriceUsd: 2.5,
        currentPriceUsd: 2.115,
        solAmount: 0.5,
        isDryRun: true,
        strategy: 'TRENDING',
        status: 'CLOSED',
      };

      const svg = PnlCardGenerator.generateCardSvg(data);
      expect(svg).toContain('WIF');
      expect(svg).toContain('-15.40%');
      expect(svg).toContain('-0.0770 SOL');
      expect(svg).toContain('#FF3B69'); // Neon coral for loss
      expect(svg).toContain('PAPER TRADING');
      expect(svg).toContain('0.85x');
    });

    it('generates a valid PNG Buffer', async () => {
      const data: PnlCardData = {
        tokenSymbol: 'SOL',
        tokenMint: 'So11111111111111111111111111111111111111112',
        isProfit: true,
        pnlPercent: 50.0,
        pnlSol: 0.25,
        entryPriceUsd: 140,
        currentPriceUsd: 210,
        solAmount: 0.5,
        isDryRun: false,
      };

      const buffer = await PnlCardGenerator.generateCardBuffer(data);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
      // Check PNG magic number header (\x89PNG\r\n\x1a\n)
      expect(buffer[0]).toBe(0x89);
      expect(buffer[1]).toBe(0x50); // P
      expect(buffer[2]).toBe(0x4e); // N
      expect(buffer[3]).toBe(0x47); // G
    }, 30000);
  });

  describe('handlePnlCard', () => {
    it('replies with photo for a valid trade', async () => {
      const mockCtx: any = {
        from: { id: 101 },
        reply: vi.fn().mockResolvedValue(true),
        replyWithPhoto: vi.fn().mockResolvedValue(true),
        callbackQuery: { data: 'pnl_card:trade1' },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
      };

      const mockTradeRepo: any = {
        getTradeById: vi.fn().mockResolvedValue({
          id: 'trade1',
          user_id: 101,
          token_symbol: 'POPCAT',
          token_mint: '7GCihKNGrSLdnMRPioE2qnAfp4BJZk8ugbFCZibpump',
          status: 'OPEN',
          is_dry_run: false,
          sol_amount: 1.0,
          token_amount: 1000,
          entry_price_usd: 1.0,
          strategy: 'TRENDING',
        }),
      };

      const mockScannerService: any = {
        scanTokenByAddress: vi.fn().mockResolvedValue({
          priceUsd: '1.80',
        }),
      };

      await handlePnlCard(mockCtx, 'trade1', mockTradeRepo, mockScannerService);

      expect(mockCtx.answerCallbackQuery).toHaveBeenCalled();
      expect(mockCtx.replyWithPhoto).toHaveBeenCalled();

      const [inputFile, options] = mockCtx.replyWithPhoto.mock.calls[0];
      expect(inputFile).toBeDefined();
      expect(options.caption).toContain('POPCAT');
      expect(options.caption).toContain('Return:');
      expect(options.parse_mode).toBe('HTML');
      expect(options.reply_markup).toBeDefined();
    }, 30000);

    it('rejects when trade does not belong to user', async () => {
      const mockCtx: any = {
        from: { id: 101 },
        reply: vi.fn().mockResolvedValue(true),
        callbackQuery: null,
      };

      const mockTradeRepo: any = {
        getTradeById: vi.fn().mockResolvedValue({
          id: 'trade99',
          user_id: 999, // different user
        }),
      };

      const mockScannerService: any = {
        scanTokenByAddress: vi.fn().mockResolvedValue(null),
      };

      await handlePnlCard(mockCtx, 'trade99', mockTradeRepo, mockScannerService);

      expect(mockCtx.reply).toHaveBeenCalledWith('⚠️ Data trade tidak ditemukan.');
    });
  });
});
