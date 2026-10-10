import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handlePositionsMenu } from '../../src/modules/telegram/handlers/positionsHandler';
import { currencyService } from '../../src/utils/currencyService';

describe('Positions Handler', () => {
  beforeEach(() => {
    // Test tidak boleh memanggil CoinGecko asli: tanpa kurs, tampilan harus "N/A", bukan crash.
    vi.spyOn(currencyService, 'fetchRates').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('displays empty state when no open positions exist', async () => {
    const mockCtx: any = {
      from: { id: 123456 },
      reply: vi.fn().mockResolvedValue(true),
    };

    const mockTradeRepo: any = {
      getTradesByStatuses: vi.fn().mockResolvedValue([]),
    };
    
    const mockScannerService: any = {
      scanTokenByAddress: vi.fn().mockResolvedValue(null)
    };

    await handlePositionsMenu(mockCtx, mockTradeRepo, mockScannerService);

    expect(mockCtx.reply).toHaveBeenCalled();
    const text = mockCtx.reply.mock.calls[0][0];
    expect(text).toContain('Tidak ada posisi trading yang sedang aktif');
  });

  it('displays active positions when open trades exist', async () => {
    const mockCtx: any = {
      from: { id: 123456 },
      reply: vi.fn().mockResolvedValue(true),
    };

    const mockTradeRepo: any = {
      getTradesByStatuses: vi.fn().mockResolvedValue([
        {
          token_symbol: 'BONK',
          entry_price_usd: 0.000025,
          sol_amount: 0.5,
          token_amount: 20000,
          status: 'OPEN',
          is_dry_run: true,
        },
      ]),
    };
    
    const mockScannerService: any = {
      scanTokenByAddress: vi.fn().mockResolvedValue({ priceUsd: '0.000030' })
    };

    await handlePositionsMenu(mockCtx, mockTradeRepo, mockScannerService);

    expect(mockCtx.reply).toHaveBeenCalled();
    const text = mockCtx.reply.mock.calls[0][0];
    expect(text).toContain('BONK');
    // Removed [PAPER] check because the new UI format doesn't include it in this overview.
    expect(text).toContain('0.5 SOL');
  });

  it('menampilkan N/A (tidak crash, tidak angka palsu) bila kurs IDR tidak tersedia', async () => {
    vi.spyOn(currencyService, 'solToIdr').mockReturnValue(null);
    const mockCtx: any = { from: { id: 1 }, reply: vi.fn().mockResolvedValue(true) };
    const mockTradeRepo: any = {
      getTradesByStatuses: vi.fn().mockResolvedValue([
        { id: 't1', token_symbol: 'BONK', token_mint: 'M', entry_price_usd: 0.00002, sol_amount: 0.5, token_amount: 20000, status: 'OPEN', is_dry_run: true },
      ]),
    };
    const mockScanner: any = { scanTokenByAddress: vi.fn().mockResolvedValue({ priceUsd: '0.00003' }) };

    await handlePositionsMenu(mockCtx, mockTradeRepo, mockScanner);

    const text = mockCtx.reply.mock.calls[0][0];
    expect(text).toContain('BONK');
    expect(text).toContain('PnL: +N/A');
  });
});
