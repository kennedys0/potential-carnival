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
⚙️ <b>New Token Sniper Settings</b>

• <b>Status:</b> ${config.enabled ? '🟢 Enabled' : '🔴 Disabled'}
• <b>Mode Eksekusi:</b> ${modeTag}

<b>Trading Rules:</b>
• <b>Ukuran Buy:</b> ${config.buy_amount_sol} SOL
• <b>Max Daily Buys:</b> ${config.max_buys_per_day}
• <b>Max Daily Budget:</b> ${config.max_daily_entry_budget_sol} SOL
• <b>Max Active Positions:</b> ${config.max_active_positions}
• <b>Pool Age:</b> ${config.min_pool_age_seconds}s–${config.max_pool_age_minutes}min

<b>Safety Filters:</b>
• <b>Minimum Safety Score:</b> ${config.minimum_safety_score}/100
• <b>Minimum Liquidity:</b> $${config.min_liquidity_usd}
• <b>Max Slippage:</b> ${config.max_slippage_bps / 100}% (tetap dibatasi oleh global cap)

<b>Exits:</b>
• <b>Take Profit:</b> +${config.take_profit_percent}%
• <b>Stop Loss:</b> -${config.stop_loss_percent}%

<i>Pilih pengaturan yang ingin diubah:</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text(config.enabled ? '⏸ Turn OFF Sniper' : '▶️ Turn ON Sniper', 'sniper_toggle')
    .row()
    .text('🔄 Mode Eksekusi', 'sniper_settings_mode')
    .text('📏 Buy Amount', 'sniper_settings_amount')
    .row()
    .text('📈 Take Profit', 'sniper_settings_tp')
    .text('📉 Stop Loss', 'sniper_settings_sl')
    .row()
    .text('🔢 Max Positions', 'sniper_settings_positions')
    .text('🗓 Max Daily Buys', 'sniper_settings_daily_buys')
    .row()
    .text('💰 Daily Budget', 'sniper_settings_daily_budget')
    .text('⏱ Max Pool Age', 'sniper_settings_pool_age')
    .row()
    .text('💧 Min Liquidity', 'sniper_settings_liquidity')
    .text('🛡 Min Safety', 'sniper_settings_safety')
    .row()
    .text('🎚 Slippage Cap', 'sniper_settings_slippage')
    .row()
    .text('🔔 Toggle Live Feed', 'toggle_livefeed')
    .row()
    .text('⬅️ Back to Automation Center', 'menu_autopilot');

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
