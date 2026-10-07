import { Context, InlineKeyboard } from 'grammy';
import { AutopilotRepository } from '../../../database/repositories/autopilotRepository';
import { z } from 'zod';

const DisplaySafetyParamsSchema = z.object({
  min_safety_score: z.number().default(75),
  min_liquidity_usd: z.number().default(10000),
});

const DisplaySizingParamsSchema = z.object({
  fixed_sol: z.number().optional(),
});

const DisplayExitParamsSchema = z.object({
  tp1_percent: z.number().default(15),
  sl_percent: z.number().default(8),
});

export async function handleAutopilotMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const statusEmoji = config.is_active ? '🟢 <b>AKTIF</b>' : '⏸ <b>JEDA / NONAKTIF</b>';
  const modeTag = config.mode === 'PAPER' ? '🟢 <b>PAPER TRADING (Simulasi)</b>' : '⚡ <b>LIVE ON-CHAIN</b>';

  const safety = DisplaySafetyParamsSchema.parse(config.safety_params);
  const sizing = DisplaySizingParamsSchema.parse(config.sizing_params);
  const exit = DisplayExitParamsSchema.parse(config.exit_params);

  const text = `
🤖 <b>Dashboard Autopilot Scalping</b>

• <b>Status:</b> ${statusEmoji}
• <b>Mode Eksekusi:</b> ${modeTag}
• <b>Profil Risiko:</b> ⚖️ ${config.risk_profile}

⚙️ <b>Parameter Aktif:</b>
• <b>Min Safety Score:</b> ${safety.min_safety_score}/100
• <b>Min Likuiditas:</b> $${safety.min_liquidity_usd}
• <b>Ukuran Trade:</b> ${sizing.fixed_sol ?? 0.1} SOL
• <b>Target TP / SL:</b> +${exit.tp1_percent}% / -${exit.sl_percent}%

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

  const { liveFeedSubscribers } = await import('../../scanner/trendScanner.js');
  if (newActive) {
    liveFeedSubscribers.add(ctx.from.id);
  } else {
    liveFeedSubscribers.delete(ctx.from.id);
  }

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
      text += `${icon} <b>${log.action}</b> <code>${log.token_symbol || log.token_mint.slice(0, 8)}</code>\n`;
      text += `├ <b>Score:</b> ${log.safety_score}/100 🛡️\n`;
      
      if (log.safety_flags && log.safety_flags.length > 0) {
        text += `├ <b>Flags:</b> ${log.safety_flags.length > 2 ? log.safety_flags.slice(0, 2).join(', ') + ', dll' : log.safety_flags.join(', ')}\n`;
      }
      
      text += `├ <b>AI Verdict:</b> ${log.ai_verdict || 'N/A'}\n`;
      text += `└ <b>Catatan:</b> <i>${log.reason_summary}</i>\n\n`;
    }
  }

  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
  text += `\n• <i>Diperbarui pada: ${timestamp}</i>`;

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh Log', 'autopilot_logs')
    .text('🤖 Dashboard Autopilot', 'menu_autopilot')
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

export async function handleAutopilotStats(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const stats = await autopilotRepo.getStats(ctx.from.id);
  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
  
  const pnlSign = stats.dailyRealizedPnlSol >= 0 ? '+' : '';
  const cbStatus = stats.isCircuitBroken
    ? `🔴 AKTIF — ${stats.circuitBreakReason ?? 'Lihat log'}`
    : '🟢 NORMAL (Tidak Terpicu)';
  
  const text = `
📊 <b>Statistik Kinerja Autopilot</b>

• <b>Mode Operasi:</b> ${config.mode}
• <b>Total Trade Dieksekusi:</b> ${stats.totalTrades}
• <b>Realized PnL (hari ini):</b> ${pnlSign}${stats.dailyRealizedPnlSol.toFixed(4)} SOL
• <b>Consecutive Losses:</b> ${stats.consecutiveLosses}
• <b>Circuit Breaker:</b> ${cbStatus}
• <i>Diperiksa pada: ${timestamp}</i>

<i>Data diperbarui secara otomatis setiap kali trade dieksekusi dan ditutup.</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh', 'autopilot_stats')
    .text('🤖 Dashboard Autopilot', 'menu_autopilot')
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
