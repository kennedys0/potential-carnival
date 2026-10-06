import { Context, InlineKeyboard } from 'grammy';
import { AutopilotRepository } from '../../../database/repositories/autopilotRepository';

export async function handleAutopilotMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const statusEmoji = config.is_active ? '🟢 <b>AKTIF</b>' : '⏸ <b>JEDA / NONAKTIF</b>';
  const modeTag = config.mode === 'PAPER' ? '🟢 <b>PAPER TRADING (Simulasi)</b>' : '⚡ <b>LIVE ON-CHAIN</b>';

  const text = `
🤖 <b>Dashboard Autopilot Scalping</b>

• <b>Status:</b> ${statusEmoji}
• <b>Mode Eksekusi:</b> ${modeTag}
• <b>Profil Risiko:</b> ⚖️ ${config.risk_profile}

⚙️ <b>Parameter Aktif:</b>
• <b>Min Safety Score:</b> ${config.safety_params.min_safety_score}/100
• <b>Min Likuiditas:</b> $${config.safety_params.min_liquidity_usd}
• <b>Ukuran Trade:</b> ${config.sizing_params.fixed_sol} SOL
• <b>Target TP / SL:</b> +${config.exit_params.tp1_percent}% / -${config.exit_params.sl_percent}%

<i>Semua parameter di atas dapat disesuaikan lewat tombol Parameter.</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text(config.is_active ? '⏸ Jeda Autopilot' : '▶️ Aktifkan Autopilot', 'autopilot_toggle')
    .row()
    .text('🛡️ Konservatif', 'preset_conservative')
    .text('⚖️ Moderat', 'preset_moderate')
    .text('⚡ Agresif', 'preset_aggressive')
    .row()
    .text('📜 Log Keputusan', 'autopilot_logs')
    .text('📊 Statistik', 'autopilot_stats')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
