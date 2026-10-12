import { Context, InlineKeyboard } from 'grammy';
import { TradeRepository } from '../../../database/repositories/tradeRepository';

import { appSettings } from '../../../config/settings';
import { currencyService } from '../../../utils/currencyService';
import { escapeHtml } from '../formatters/messageFormatter';
import { WalletService } from '../../wallet/walletService';

export async function handleReportCommand(
  ctx: Context,
  tradeRepo: TradeRepository,
  walletService?: WalletService
): Promise<void> {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  const tz = appSettings.DAY_BOUNDARY_TZ || 'UTC';
  const now = new Date();

  try {
    const closedTrades = await tradeRepo.getClosedTradesToday(userId, tz);
    const openTrades = await tradeRepo.getOpenTradesByUserId(userId);

    // Fetch rates for IDR conversion
    await currencyService.fetchRates();

    // Check claimable rent fee
    let claimableText = '';
    let hasClaimable = false;
    let claimBtnText = '🏷️ Klaim Rent Fee';
    if (walletService) {
      try {
        const activeMints = new Set(openTrades.map((t) => t.token_mint));
        const rentInfo = await walletService.getClaimableRent(userId, activeMints);
        if (rentInfo.emptyAccountsCount > 0) {
          hasClaimable = true;
          const rentIdr = currencyService.solToIdr(rentInfo.claimableSol);
          const rentIdrText = rentIdr !== null ? ` (≈ ${currencyService.formatIdr(rentIdr)})` : '';
          claimableText = `🏷️ <b>Rent Fee Recovery:</b>\n└ <code>${rentInfo.emptyAccountsCount} Akun Kosong</code> (≈ <code>+${rentInfo.claimableSol.toFixed(4)} SOL</code>${rentIdrText})\n\n`;
          claimBtnText = `🏷️ Klaim Rent (+${rentInfo.claimableSol.toFixed(3)} SOL)`;
        }
      } catch {
        // ignore
      }
    }

    // Calculate total realized PnL today
    let totalRealizedPnlSol = 0;
    const closedBreakdown: string[] = [];

    for (const trade of closedTrades) {
      const pnl = trade.realized_pnl_sol ?? 0;
      totalRealizedPnlSol += pnl;
      
      const symbol = trade.token_symbol || trade.token_mint.slice(0, 8);
      const sign = pnl > 0 ? '+' : '';
      const icon = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '➖';
      
      const pnlIdr = currencyService.solToIdr(pnl);
      const idrText = pnlIdr !== null ? ` (≈ ${sign}${currencyService.formatIdr(pnlIdr)})` : '';
      
      closedBreakdown.push(`• ${icon} <b>${escapeHtml(symbol)}</b>: <code>${sign}${pnl.toFixed(4)} SOL</code>${idrText}`);
    }

    // Collect open tokens
    const openTokens = new Set<string>();
    for (const trade of openTrades) {
      openTokens.add(escapeHtml(trade.token_symbol || trade.token_mint.slice(0, 8)));
    }

    const todayDateStr = now.toLocaleDateString('id-ID', {
      timeZone: 'Asia/Jakarta',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    const pnlSign = totalRealizedPnlSol >= 0 ? '+' : '';
    const pnlEmoji = totalRealizedPnlSol >= 0 ? '🟩' : '🟥';
    const totalIdr = currencyService.solToIdr(totalRealizedPnlSol);
    const totalIdrText = totalIdr !== null ? ` (≈ ${pnlSign}${currencyService.formatIdr(totalIdr)})` : '';

    let text = `📈 <b>LAPORAN HARIAN (DAILY PERFORMANCE)</b>\n📅 <i>${todayDateStr}</i>\n───────────────────────────\n\n`;
    text += `💰 <b>Total Realized PnL Hari Ini:</b>\n${pnlEmoji} <code>${pnlSign}${totalRealizedPnlSol.toFixed(4)} SOL</code>${totalIdrText}\n\n`;
    
    text += `✅ <b>Posisi Selesai (Closed): ${closedTrades.length} Trade</b>\n`;
    if (closedBreakdown.length > 0) {
      text += `${closedBreakdown.join('\n')}\n\n`;
    } else {
      text += `└ <i>Belum ada trade yang ditutup hari ini.</i>\n\n`;
    }

    text += `⏳ <b>Posisi Aktif (Open): ${openTrades.length} Trade</b>\n`;
    if (openTokens.size > 0) {
      text += `└ <i>${Array.from(openTokens).join(', ')}</i>\n\n`;
    } else {
      text += `└ <i>Tidak ada posisi terbuka saat ini.</i>\n\n`;
    }

    if (claimableText) {
      text += claimableText;
    }

    text += `───────────────────────────\n🕒 <i>Diperbarui: ${now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</i>`;

    const keyboard = new InlineKeyboard();
    if (hasClaimable) {
      keyboard.text(claimBtnText, 'claim_rent').row();
    }
    keyboard
      .text('📊 Cek Portofolio', 'menu_positions')
      .text('🔄 Refresh', 'menu_report')
      .row()
      .text('🏠 Dashboard Utama', 'menu_main');

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch (err: any) {
        if (err?.description?.includes('message is not modified')) return;
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } catch (error: any) {
    await ctx.reply(`⚠️ Gagal mengambil report: ${escapeHtml(error.message || 'Error tidak diketahui')}`, { parse_mode: 'HTML' });
  }
}
