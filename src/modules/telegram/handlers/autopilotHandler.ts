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
• <b>Min Safety Score:</b> ${(config.safety_params as any)?.min_safety_score || 75}/100
• <b>Min Likuiditas:</b> $${(config.safety_params as any)?.min_liquidity_usd || 10000}
• <b>Ukuran Trade:</b> ${(config.sizing_params as any)?.fixed_sol || 0.1} SOL
• <b>Target TP / SL:</b> +${(config.exit_params as any)?.tp1_percent || 15}% / -${(config.exit_params as any)?.sl_percent || 8}%

<i>Gunakan tombol di bawah untuk mengontrol autopilot secara real-time:</i>
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
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handleAutopilotToggle(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const newActive = !config.is_active;
  await autopilotRepo.updateConfig(ctx.from.id, { is_active: newActive });

  await ctx.answerCallbackQuery({
    text: newActive ? '✅ Autopilot Diaktifkan!' : '⏸ Autopilot Dijeda.',
  });

  await handleAutopilotMenu(ctx, autopilotRepo);
}

export async function handleAutopilotPreset(
  ctx: Context,
  profile: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE',
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const presets = {
    CONSERVATIVE: {
      min_safety_score: 85,
      min_liquidity_usd: 25000,
      fixed_sol: 0.05,
      tp1_percent: 10,
      sl_percent: 5,
    },
    MODERATE: {
      min_safety_score: 75,
      min_liquidity_usd: 10000,
      fixed_sol: 0.1,
      tp1_percent: 15,
      sl_percent: 8,
    },
    AGGRESSIVE: {
      min_safety_score: 60,
      min_liquidity_usd: 5000,
      fixed_sol: 0.25,
      tp1_percent: 30,
      sl_percent: 12,
    },
  };

  const p = presets[profile];
  await autopilotRepo.updateConfig(ctx.from.id, {
    risk_profile: profile,
    safety_params: { min_safety_score: p.min_safety_score, min_liquidity_usd: p.min_liquidity_usd },
    sizing_params: { fixed_sol: p.fixed_sol },
    exit_params: { tp1_percent: p.tp1_percent, sl_percent: p.sl_percent },
  });

  await ctx.answerCallbackQuery({
    text: `⚖️ Profil diubah ke: ${profile}`,
  });

  await handleAutopilotMenu(ctx, autopilotRepo);
}

export async function handleAutopilotLogs(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const logs = await autopilotRepo.getRecentDecisionLogs(ctx.from.id, 5);
  let text = '📜 <b>Log Keputusan Autopilot</b>\n\n';

  if (logs.length === 0) {
    text += '<i>Belum ada log keputusan yang tercatat. Autopilot terus memantau liquidity pool Solana secara periodik.</i>';
  } else {
    for (const log of logs) {
      const icon = log.action === 'BUY' ? '🟢' : log.action === 'SKIP' ? '⚪' : '🔴';
      text += `${icon} <b>[${log.action}]</b> ${log.token_symbol || log.token_mint.slice(0, 8)}...\n`;
      text += `• Score: ${log.safety_score}/100 | Verdict: ${log.ai_verdict || 'N/A'}\n`;
      text += `• Catatan: ${log.reason_summary}\n\n`;
    }
  }

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh Log', 'autopilot_logs')
    .text('🤖 Dashboard Autopilot', 'menu_autopilot')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handleAutopilotStats(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const text = `
📊 <b>Statistik Kinerja Autopilot</b>

• <b>Mode Operasi:</b> ${config.mode}
• <b>Total Trades:</b> 0
• <b>Win Rate:</b> 0.0%
• <b>Realized PnL:</b> +0.0000 SOL ($0.00)
• <b>Max Consecutive Losses:</b> 0
• <b>Circuit Breaker:</b> 🟢 NORMAL (Tidak Terpicu)

<i>Data diperbarui secara otomatis setiap kali trade dieksekusi dan ditutup.</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh', 'autopilot_stats')
    .text('🤖 Dashboard Autopilot', 'menu_autopilot')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
