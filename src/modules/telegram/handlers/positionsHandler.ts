import { Context, InlineKeyboard } from 'grammy';
import { TradeRepository } from '../../../database/repositories/tradeRepository';

import { currencyService } from '../../../utils/currencyService';
import { ScannerService } from '../../scanner/scannerService';
import { AccountingEngine } from '../../trader/accountingEngine.js';
import { escapeHtml } from '../formatters/messageFormatter';

export async function handlePositionsMenu(
  ctx: Context,
  tradeRepo: TradeRepository,
  scannerService: ScannerService
): Promise<void> {
  if (!ctx.from) return;

  const openTrades = await tradeRepo.getTradesByStatuses(ctx.from.id, [
    'RESERVED',
    'SIGNED',
    'BROADCAST_ATTEMPTED',
    'PENDING',
    'OPEN',
    'PARTIAL_EXIT',
  ]);
  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';

  const keyboard = new InlineKeyboard();
  let text = '';

  if (openTrades.length === 0) {
    text = `
📊 <b>Portofolio Kosong</b>

<i>Tidak ada posisi trading yang sedang aktif.</i>

💡 <b>Cara Membuka Posisi:</b>
1. Ketik <code>/scan &lt;CA&gt;</code> untuk menganalisis token.
2. Gunakan tombol Buy untuk eksekusi manual.
3. Aktifkan <b>🤖 Autopilot</b> untuk auto-snipe.

• <i>Diperbarui: ${timestamp}</i>
`.trim();
  } else {
    text = `📊 <b>Portofolio Aktif (${openTrades.length})</b>\n\n`;
    await currencyService.fetchRates();

    const pricePromises = openTrades.map(t => scannerService.scanTokenByAddress(t.token_mint));
    const pairs = await Promise.all(pricePromises);

    let totalPnlUsd = 0;
    let totalPnlSol = 0;

    for (let i = 0; i < openTrades.length; i++) {
      const trade = openTrades[i];
      const pair = pairs[i];
      const currentPriceUsd = pair ? parseFloat(pair.priceUsd || '0') : 0;
      
      const mode = trade.is_dry_run ? '🟢' : '⚡';
      let pnlPercent = 0;
      let pnlSol = 0;
      let pnlIcon = '➖';
      
      const isPending = !['OPEN', 'PARTIAL_EXIT'].includes(trade.status);

      if (!isPending && currentPriceUsd > 0 && trade.entry_price_usd > 0) {
        const liveAcct = AccountingEngine.calculateLiveValuation({
          trade,
          currentPriceUsd
        });
        pnlPercent = liveAcct.pnlPercent;
        pnlSol = liveAcct.pnlSol;
        pnlIcon = pnlPercent > 0 ? '🟢' : pnlPercent < 0 ? '🔴' : '➖';
        totalPnlUsd += (currencyService.solToUsd(liveAcct.pnlSol) ?? 0);
        totalPnlSol += liveAcct.pnlSol;
      }
      
      const pnlIdr = currencyService.solToIdr(pnlSol);

      if (isPending) {
         text += `${i + 1}. ${mode} <b>${escapeHtml(trade.token_symbol)}</b> | ⏳ <b>${trade.status}</b>\n`;
         text += `   ↳ <code>Membeli...</code> | Harap tunggu konfirmasi\n\n`;
      } else {
         text += `${i + 1}. ${mode} <b>${escapeHtml(trade.token_symbol)}</b> | ${pnlIcon} <b>${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b>\n`;
         text += `   ↳ <code>${trade.sol_amount} SOL</code> | PnL: ${pnlSol >= 0 ? '+' : ''}${currencyService.formatIdr(pnlIdr)}\n\n`;
      }
      
      keyboard.text(`${trade.token_symbol}`, `view_pos:${trade.id}`);
      if ((i + 1) % 2 === 0) keyboard.row();
    }
    
    if (openTrades.length % 2 !== 0) keyboard.row();

    const totalPnlIdr = currencyService.solToIdr(totalPnlSol);
    text += `\n💰 <b>Total Unre. PnL:</b> ${totalPnlSol >= 0 ? '+' : ''}${totalPnlSol.toFixed(4)} SOL (≈ ${totalPnlIdr !== null && totalPnlIdr >= 0 ? '+' : ''}${currencyService.formatIdr(totalPnlIdr)})\n`;
    text += `• <i>Diperbarui: ${timestamp}</i>`;
  }

  keyboard.row();
  keyboard
    .text('🔄 Refresh', 'menu_positions')
    .text('🏠 Dashboard', 'menu_main');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handlePositionDetail(
  ctx: Context,
  tradeId: string,
  tradeRepo: TradeRepository,
  scannerService: ScannerService
): Promise<void> {
  if (!ctx.from) return;

  const trade = await tradeRepo.getTradeById(tradeId);
  if (!trade || trade.user_id !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: '⚠️ Posisi tidak ditemukan atau sudah ditutup.' });
    return;
  }

  await currencyService.fetchRates();
  const pair = await scannerService.scanTokenByAddress(trade.token_mint);
  const currentPriceUsd = pair ? parseFloat(pair.priceUsd || '0') : 0;
  
  const modeBadge = trade.is_dry_run ? '🟢 [PAPER]' : '⚡ [LIVE]';
  
  let pnlPercent = 0;
  let pnlSol = 0;
  let pnlUsd = 0;
  let pnlIdr: number | null = 0;
  
  const isPending = !['OPEN', 'PARTIAL_EXIT'].includes(trade.status);
  
  if (!isPending && currentPriceUsd > 0 && trade.entry_price_usd > 0) {
    const liveAcct = AccountingEngine.calculateLiveValuation({
      trade,
      currentPriceUsd
    });
    pnlPercent = liveAcct.pnlPercent;
    pnlSol = liveAcct.pnlSol;
    pnlUsd = currencyService.solToUsd(liveAcct.pnlSol) ?? 0;
    pnlIdr = currencyService.solToIdr(liveAcct.pnlSol);
  }

  const pnlIcon = pnlPercent > 0 ? '🟢' : pnlPercent < 0 ? '🔴' : '➖';
  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';

  const text = isPending ? `
📈 <b>Detail Posisi: ${escapeHtml(trade.token_symbol)}</b>
<code>${escapeHtml(trade.token_mint)}</code>

• <b>Mode:</b> ${modeBadge}
• <b>Status:</b> ⏳ <code>${trade.status}</code>
• <b>Alokasi:</b> ${trade.sol_amount} SOL

<i>Order Anda sedang diproses dan menunggu konfirmasi jaringan. Silakan refresh dalam beberapa detik.</i>

<i>Diperbarui: ${timestamp}</i>
`.trim() : `
📈 <b>Detail Posisi: ${escapeHtml(trade.token_symbol)}</b>
<code>${escapeHtml(trade.token_mint)}</code>

• <b>Mode:</b> ${modeBadge}
• <b>Status:</b> <code>${trade.status}</code>
• <b>Ukuran:</b> ${trade.sol_amount} SOL (${trade.token_amount.toFixed(2)} tokens)

<b>Performa Harga:</b>
• <b>Entry:</b> $${trade.entry_price_usd.toFixed(6)}
• <b>Sekarang:</b> $${currentPriceUsd.toFixed(6)}
• <b>PnL:</b> ${pnlIcon} <b>${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b>
• <b>Value:</b> ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (≈ ${pnlIdr !== null && pnlIdr >= 0 ? '+' : ''}${currencyService.formatIdr(pnlIdr)})

<i>Diperbarui: ${timestamp}</i>
`.trim();

  const keyboard = new InlineKeyboard();
  if (!isPending) {
    keyboard.text('🔴 Jual Semua (100%)', `sell:${trade.id}:100`).row();
  }
  keyboard
    .text('🔄 Refresh', `view_pos:${trade.id}`)
    .text('🔙 Kembali', 'menu_positions');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
