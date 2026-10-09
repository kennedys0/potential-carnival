import { Context, InlineKeyboard } from 'grammy';
import { AutopilotRepository } from '../../../database/repositories/autopilotRepository';

export async function handleSettingsMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const isPaper = config.mode === 'PAPER';
  const modeBadge = isPaper ? '🟢 PAPER TRADING (Simulasi)' : '⚡ LIVE ON-CHAIN';
  const fixedSol = (config.sizing_params as any)?.fixed_sol ?? 0.1;
  const minScore = (config.safety_params as any)?.min_safety_score ?? 75;

  const slPercent = (config.exit_params as any)?.sl_percent ?? 8;
  const tp1Percent = (config.exit_params as any)?.tp1_percent ?? 15;
  const trailingEnabled = (config.exit_params as any)?.trailing_stop_enabled || false;

  const text = `
⚙️ <b>Pengaturan Scalping & Trading Bot</b>

• <b>Mode Eksekusi:</b> ${modeBadge}
• <b>Profil Risiko:</b> ⚖️ ${config.risk_profile}
• <b>Default Trade Size:</b> <code>${fixedSol} SOL</code>
• <b>Min Security Score:</b> <code>${minScore}/100</code>
• <b>Stop Loss (SL):</b> <code>${slPercent}%</code>
• <b>Take Profit (TP1):</b> <code>${tp1Percent}%</code>
• <b>Trailing Stop:</b> ${trailingEnabled ? '🟢 AKTIF' : '🔴 NONAKTIF'} (Aktif: <code>+${(config.exit_params as any)?.trailing_activation_percent ?? 20}%</code>, Jarak: <code>${(config.exit_params as any)?.trailing_stop_percent ?? 5}%</code>)
• <b>Status Autopilot:</b> ${config.is_active ? '🟢 AKTIF' : '⏸ NONAKTIF'}

<i>Gunakan tombol di bawah untuk mengubah parameter trading Anda secara langsung:</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text(isPaper ? '⚡ Beralih ke LIVE' : '🟢 Beralih ke PAPER', 'settings_toggle_mode')
    .row()
    .text('🛡️ Konservatif', 'preset_conservative')
    .text('⚖️ Moderat', 'preset_moderate')
    .text('⚡ Agresif', 'preset_aggressive')
    .row()
    .text('💰 Size: 0.01', 'settings_size_0.01')
    .text('💰 Size: 0.02', 'settings_size_0.02')
    .text('💰 Size: 0.05', 'settings_size_0.05')
    .row()
    .text('💰 Size: 0.1', 'settings_size_0.1')
    .text('💰 Size: 0.25', 'settings_size_0.25')
    .text('💰 Size: 0.5', 'settings_size_0.5')
    .row()
    .text(`📉 Set SL (${slPercent}%)`, 'settings_cycle_sl')
    .text(`📈 Set TP (${tp1Percent}%)`, 'settings_cycle_tp')
    .row()
    .text(`Trailing: ${trailingEnabled ? 'ON' : 'OFF'}`, 'settings_toggle_trailing')
    .text(`Jarak: ${(config.exit_params as any)?.trailing_stop_percent ?? 5}%`, 'settings_cycle_trail_dist')
    .text(`Mulai: +${(config.exit_params as any)?.trailing_activation_percent ?? 20}%`, 'settings_cycle_trail_start')
    .row()
    .text('📈 Trending Controls', 'menu_autopilot')
    .text('⚡ Sniper Settings', 'sniper_settings')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

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
