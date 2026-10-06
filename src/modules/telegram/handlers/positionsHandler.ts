import { Context, InlineKeyboard } from 'grammy';
import { TradeRepository } from '../../../database/repositories/tradeRepository';

export async function handlePositionsMenu(
  ctx: Context,
  tradeRepo: TradeRepository
): Promise<void> {
  if (!ctx.from) return;

  const openTrades = await tradeRepo.getOpenTradesByUserId(ctx.from.id);

  let text = '';
  if (openTrades.length === 0) {
    text = `
📊 <b>Posisi Trading Aktif</b>

<i>Saat ini belum ada posisi trading yang aktif (0 Open Positions).</i>

💡 <b>Cara Membuka Posisi:</b>
1. Ketik <code>/scan &lt;CA&gt;</code> untuk menganalisis token Solana.
2. Gunakan tombol Buy untuk eksekusi manual (Paper/Live).
3. Atau aktifkan <b>🤖 Autopilot</b> untuk auto-snipe otomatis sesuai kriteria AI.
`.trim();
  } else {
    text = `📊 <b>Daftar Posisi Aktif (${openTrades.length})</b>\n\n`;
    for (const trade of openTrades) {
      const mode = trade.is_dry_run ? '🟢 [PAPER]' : '⚡ [LIVE]';
      text += `${mode} <b>${trade.token_symbol}</b>\n`;
      text += `• <b>Entry:</b> $${trade.entry_price_usd.toFixed(6)}\n`;
      text += `• <b>Ukuran:</b> ${trade.sol_amount} SOL (${trade.token_amount.toFixed(2)} tokens)\n`;
      text += `• <b>Status:</b> <code>${trade.status}</code>\n\n`;
    }
  }

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh Posisi', 'menu_positions')
    .text('🔍 Scan Token', 'menu_scan')
    .row()
    .text('🤖 Autopilot', 'menu_autopilot')
    .text('🏠 Menu Utama', 'menu_main');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
