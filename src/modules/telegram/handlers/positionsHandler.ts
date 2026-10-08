import { Context, InlineKeyboard } from 'grammy';
import { TradeRepository } from '../../../database/repositories/tradeRepository';

import { currencyService } from '../../../utils/currencyService';
import { ScannerService } from '../../scanner/scannerService';
import { AccountingEngine } from '../../trader/accountingEngine.js';

export async function handlePositionsMenu(
  ctx: Context,
  tradeRepo: TradeRepository,
  scannerService: ScannerService
): Promise<void> {
  if (!ctx.from) return;

  const openTrades = await tradeRepo.getOpenTradesByUserId(ctx.from.id);
  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';

  const keyboard = new InlineKeyboard();
  let text = '';

  if (openTrades.length === 0) {
    text = `
📊 <b>Posisi Trading Aktif</b>

<i>Saat ini belum ada posisi trading yang aktif (0 Open Positions).</i>

💡 <b>Cara Membuka Posisi:</b>
1. Ketik <code>/scan &lt;CA&gt;</code> untuk menganalisis token Solana.
2. Gunakan tombol Buy untuk eksekusi manual (Paper/Live).
3. Atau aktifkan <b>🤖 Autopilot</b> untuk auto-snipe otomatis sesuai kriteria AI.

• <i>Diperiksa pada: ${timestamp}</i>
`.trim();
  } else {
    text = `📊 <b>Daftar Posisi Aktif (${openTrades.length})</b>\n\n`;
    await currencyService.fetchRates();

    // Fetch live prices for all tokens concurrently
    const pricePromises = openTrades.map(t => scannerService.scanTokenByAddress(t.token_mint));
    const pairs = await Promise.all(pricePromises);

    for (let i = 0; i < openTrades.length; i++) {
      const trade = openTrades[i];
      const pair = pairs[i];
      const currentPriceUsd = pair ? parseFloat(pair.priceUsd || '0') : 0;
      
      const mode = trade.is_dry_run ? '🟢 [PAPER]' : '⚡ [LIVE]';
      const entryPrice = trade.entry_price_usd;
      
      let pnlPercent = 0;
      let pnlSol = 0;
      let pnlIdr: number | null = null;
      let pnlIcon = '➖';
      
      if (currentPriceUsd > 0 && entryPrice > 0) {
        // Use AccountingEngine for accurate live PnL instead of naive price differences
        const liveAcct = AccountingEngine.calculateLiveValuation({
          trade,
          currentPriceUsd
        });
        
        pnlPercent = liveAcct.pnlPercent;
        pnlSol = liveAcct.pnlSol;
        pnlIdr = currencyService.solToIdr(pnlSol);
        pnlIcon = pnlPercent > 0 ? '🟢' : pnlPercent < 0 ? '🔴' : '➖';
      }

      text += `${i + 1}. ${mode} <b>${trade.token_symbol}</b>\n`;
      text += `   • <b>Ukuran:</b> ${trade.sol_amount} SOL (${trade.token_amount.toFixed(2)} tokens)\n`;
      text += `   • <b>Entry:</b> $${entryPrice.toFixed(6)}\n`;
      text += `   • <b>Current:</b> $${currentPriceUsd.toFixed(6)}\n`;
      text += `   • <b>PnL:</b> ${pnlIcon} <b>${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b> (${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)\n`;
      text += `   • <b>Profit/Loss:</b> ${pnlIdr !== null && pnlIdr > 0 ? '+' : ''}${currencyService.formatIdr(pnlIdr)}\n`;
      text += `   • <b>Status:</b> <code>${trade.status}</code>\n\n`;
      
      // Add a sell button for this trade
      keyboard.text(`🔴 Sell ${trade.token_symbol}`, `sell:${trade.id}:100`).row();
    }
    text += `• <i>Diperbarui pada: ${timestamp}</i>`;
  }

  keyboard
    .text('🔄 Refresh Posisi', 'menu_positions')
    .text('🔍 Scan Token', 'menu_scan')
    .row()
    .text('🤖 Autopilot', 'menu_autopilot')
    .text('🏠 Menu Utama', 'menu_main');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) {
        return;
      }
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
