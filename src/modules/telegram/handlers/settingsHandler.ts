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
  const fixedSol = (config.sizing_params as any)?.fixed_sol || 0.1;
  const minScore = (config.safety_params as any)?.min_safety_score || 75;

  const text = `
⚙️ <b>Pengaturan Scalping & Trading Bot</b>

• <b>Mode Eksekusi:</b> ${modeBadge}
• <b>Profil Risiko:</b> ⚖️ ${config.risk_profile}
• <b>Default Trade Size:</b> <code>${fixedSol} SOL</code>
• <b>Min Security Score:</b> <code>${minScore}/100</code>
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
    .text('💰 Size: 0.05 SOL', 'settings_size_0.05')
    .text('💰 Size: 0.1 SOL', 'settings_size_0.1')
    .text('💰 Size: 0.25 SOL', 'settings_size_0.25')
    .row()
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
