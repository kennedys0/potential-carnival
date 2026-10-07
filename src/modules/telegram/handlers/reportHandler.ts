import { Context } from 'grammy';
import { TradeRepository } from '../../../database/repositories/tradeRepository';

export async function handleReportCommand(
  ctx: Context,
  tradeRepo: TradeRepository
): Promise<void> {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  // Get start of day (midnight) in local time (WIB/Jakarta for example)
  // For simplicity, we just use UTC midnight as start of day, or construct a simple ISO string
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDayStr = startOfDay.toISOString();

  try {
    const closedTrades = await tradeRepo.getClosedTradesSince(userId, startOfDayStr);
    const openTrades = await tradeRepo.getOpenTradesByUserId(userId);

    // Calculate total realized PnL today
    let totalRealizedPnlSol = 0;
    const closedTokens = new Set<string>();

    for (const trade of closedTrades) {
      if (trade.realized_pnl_sol) {
        totalRealizedPnlSol += trade.realized_pnl_sol;
      }
      closedTokens.add(trade.token_symbol || trade.token_mint);
    }

    // Collect open tokens
    const openTokens = new Set<string>();
    for (const trade of openTrades) {
      openTokens.add(trade.token_symbol || trade.token_mint);
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

    let text = `📈 <b>DAILY REPORT</b>\n📅 <i>${todayDateStr}</i>\n\n`;
    text += `💰 <b>Realized PnL Hari Ini:</b>\n${pnlEmoji} ${pnlSign}${totalRealizedPnlSol.toFixed(4)} SOL\n\n`;
    
    text += `✅ <b>Token Selesai (Closed): ${closedTrades.length} Trades</b>\n`;
    if (closedTokens.size > 0) {
      text += `└ <i>${Array.from(closedTokens).join(', ')}</i>\n\n`;
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
