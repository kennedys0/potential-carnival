import { Context } from 'grammy';
import { TradeRepository } from '../../../database/repositories/tradeRepository';

import { appSettings } from '../../../config/settings';
import { currencyService } from '../../../utils/currencyService';

export async function handleReportCommand(
  ctx: Context,
  tradeRepo: TradeRepository
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
      
      closedBreakdown.push(`└ ${icon} <b>${symbol}</b>: ${sign}${pnl.toFixed(4)} SOL${idrText}`);
    }

    // Collect open tokens
    const openTokens = new Set<string>();
    for (const trade of openTrades) {
      openTokens.add(trade.token_symbol || trade.token_mint.slice(0, 8));
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

    let text = `📈 <b>DAILY REPORT</b>\n📅 <i>${todayDateStr}</i>\n\n`;
    text += `💰 <b>Realized PnL Hari Ini:</b>\n${pnlEmoji} ${pnlSign}${totalRealizedPnlSol.toFixed(4)} SOL${totalIdrText}\n\n`;
    
    text += `✅ <b>Token Selesai (Closed): ${closedTrades.length} Trades</b>\n`;
    if (closedBreakdown.length > 0) {
      text += `${closedBreakdown.join('\n')}\n\n`;
    } else {
      text += `└ <i>Tidak ada</i>\n\n`;
    }

    text += `⏳ <b>Token Berjalan (Open): ${openTrades.length} Trades</b>\n`;
    if (openTokens.size > 0) {
      text += `└ <i>${Array.from(openTokens).join(', ')}</i>\n`;
    } else {
      text += `└ <i>Tidak ada</i>\n`;
    }

    await ctx.reply(text, { parse_mode: 'HTML' });
  } catch (error: any) {
    await ctx.reply(`⚠️ Gagal mengambil report: ${error.message}`);
  }
}
