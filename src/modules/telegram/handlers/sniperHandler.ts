import { Context, InlineKeyboard } from 'grammy';
import { SniperRepository } from '../../../database/repositories/sniperRepository';

export async function handleSniperSettings(
  ctx: Context,
  sniperRepo: SniperRepository
): Promise<void> {
  if (!ctx.from) return;
  const config = await sniperRepo.getOrCreateConfig(ctx.from.id);
  const modeTag = config.trading_mode === 'PAPER' ? '🟢 PAPER TRADING (Simulasi)' : '⚡ LIVE ON-CHAIN';

  const text = `
⚡ <b>Pengaturan New Token Sniper</b>
───────────────────────────
• <b>Status:</b> ${config.enabled ? '🟢 AKTIF' : '🔴 NONAKTIF'}
• <b>Mode Eksekusi:</b> ${modeTag}

<b>Aturan Trading & Ukuran:</b>
• <b>Ukuran Buy:</b> <code>${config.buy_amount_sol} SOL</code>
• <b>Max Daily Buys:</b> <code>${config.max_buys_per_day} Trade</code>
• <b>Max Daily Budget:</b> <code>${config.max_daily_entry_budget_sol} SOL</code>
• <b>Max Posisi Aktif:</b> <code>${config.max_active_positions} Posisi</code>
• <b>Rentang Umur Pool:</b> <code>${config.min_pool_age_seconds}d – ${config.max_pool_age_minutes}m</code>

<b>Filter Keamanan & Slippage:</b>
• <b>Minimum Safety Score:</b> <code>${config.minimum_safety_score}/100</code>
• <b>Minimum Likuiditas:</b> <code>$${config.min_liquidity_usd.toLocaleString('en-US')}</code>
• <b>Max Slippage:</b> <code>${config.max_slippage_bps / 100}%</code>

<b>Target Exit Otomatis:</b>
• <b>Take Profit (TP):</b> <code>+${config.take_profit_percent}%</code>
• <b>Stop Loss (SL):</b> <code>-${config.stop_loss_percent}%</code>
───────────────────────────
<i>Tap tombol di bawah untuk mengubah nilai secara langsung:</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text(config.enabled ? '⏸ Matikan Sniper' : '⚡ Nyalakan Sniper', 'sniper_toggle')
    .text(`🔄 Mode: ${config.trading_mode}`, 'sniper_settings_mode')
    .row()
    .text(`📏 Size: ${config.buy_amount_sol} SOL`, 'sniper_settings_amount')
    .text(`🎯 TP: +${config.take_profit_percent}%`, 'sniper_settings_tp')
    .row()
    .text(`🛑 SL: -${config.stop_loss_percent}%`, 'sniper_settings_sl')
    .text(`🔢 Max: ${config.max_active_positions} Pos`, 'sniper_settings_positions')
    .row()
    .text(`💰 Budget: ${config.max_daily_entry_budget_sol} SOL`, 'sniper_settings_daily_budget')
    .text(`🗓 Daily: ${config.max_buys_per_day}x`, 'sniper_settings_daily_buys')
    .row()
    .text(`🛡 Min: ${config.minimum_safety_score}/100`, 'sniper_settings_safety')
    .text(`💧 Liq: $${config.min_liquidity_usd >= 1000 ? `${config.min_liquidity_usd / 1000}k` : config.min_liquidity_usd}`, 'sniper_settings_liquidity')
    .row()
    .text(`⏱ Max Umur: ${config.max_pool_age_minutes}m`, 'sniper_settings_pool_age')
    .text(`🎚 Slip: ${config.max_slippage_bps / 100}%`, 'sniper_settings_slippage')
    .row()
    .text('🔔 Toggle Notifikasi Live Feed', 'toggle_livefeed')
    .row()
    .text('🔙 Automation Center', 'menu_autopilot')
    .text('🏠 Dashboard', 'menu_main');

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
