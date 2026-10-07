import { describe, it, expect, vi } from 'vitest';
import { handlePositionsMenu } from '../../src/modules/telegram/handlers/positionsHandler';

describe('Positions Handler', () => {
  it('displays empty state when no open positions exist', async () => {
    const mockCtx: any = {
      from: { id: 123456 },
      reply: vi.fn().mockResolvedValue(true),
    };

    const mockTradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([]),
    };
    
    const mockScannerService: any = {
      scanTokenByAddress: vi.fn().mockResolvedValue(null)
    };

    await handlePositionsMenu(mockCtx, mockTradeRepo, mockScannerService);

    expect(mockCtx.reply).toHaveBeenCalled();
    const text = mockCtx.reply.mock.calls[0][0];
    expect(text).toContain('Saat ini belum ada posisi trading yang aktif');
  });

  it('displays active positions when open trades exist', async () => {
    const mockCtx: any = {
      from: { id: 123456 },
      reply: vi.fn().mockResolvedValue(true),
    };

    const mockTradeRepo: any = {
      getOpenTradesByUserId: vi.fn().mockResolvedValue([
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
    expect(text).toContain('[PAPER]');
    expect(text).toContain('0.5 SOL');
  });
});
