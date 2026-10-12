import { Context, InlineKeyboard } from 'grammy';
import { AutopilotRepository } from '../../../database/repositories/autopilotRepository';
import { SniperRepository } from '../../../database/repositories/sniperRepository';
import { liveFeedSubscribers } from '../../scanner/liveFeedState';
import { escapeHtml } from '../formatters/messageFormatter';

export async function handleAutopilotMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository,
  sniperRepo: SniperRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const sniperConfig = await sniperRepo.getOrCreateConfig(ctx.from.id);
  
  const trendingStatus = config.is_active ? '🟢 AKTIF' : '⏸ JEDA';
  const sniperStatus = sniperConfig.enabled ? '🟢 AKTIF' : '🔴 NONAKTIF';

  const sizing = (config.sizing_params as any) || {};
  const trendingBuySol = typeof sizing.fixed_sol === 'number' && !Number.isNaN(sizing.fixed_sol) ? sizing.fixed_sol : 0.1;

  const text = `
🤖 <b>AUTOMATION & AUTOPILOT CENTER</b>
───────────────────────────
📈 <b>1. Trending Scalper (GeckoTerminal)</b>
• <b>Status:</b> ${trendingStatus}
• <b>Alokasi per Trade:</b> <code>${trendingBuySol} SOL</code>
• <b>Strategi:</b> Momentum breakout token trending

⚡ <b>2. New Token Sniper (Pools Baru)</b>
• <b>Status:</b> ${sniperStatus}
• <b>Alokasi per Trade:</b> <code>${sniperConfig.buy_amount_sol} SOL</code>
• <b>Batas Harian:</b> <code>${sniperConfig.max_buys_per_day} Buys/Hari</code>
───────────────────────────
<i>Tap tombol di bawah untuk toggle aktif atau konfigurasi:</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text(config.is_active ? '⏸ Matikan Trending' : '▶️ Nyalakan Trending', 'autopilot_toggle')
    .text('⚙️ Set Parameter', 'menu_settings')
    .row()
    .text(sniperConfig.enabled ? '🔴 Matikan Sniper' : '⚡ Nyalakan Sniper', 'sniper_toggle')
    .text('⚙️ Set Rules Sniper', 'sniper_settings')
    .row()
    .text('📜 Log Keputusan AI', 'autopilot_logs')
    .text('📊 Statistik Kinerja', 'autopilot_stats')
    .row()
    .text('📡 Radar Hub Live Feed', 'menu_radar')
    .text('🏠 Dashboard Utama', 'menu_main');

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
  autopilotRepo: AutopilotRepository,
  sniperRepo: SniperRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const newActive = !config.is_active;
  await autopilotRepo.updateConfig(ctx.from.id, {
    is_active: newActive,
    safety_params: { ...config.safety_params, enable_trending: newActive },
  });

  if (newActive) {
    liveFeedSubscribers.add(ctx.from.id);
  } else {
    // Only delete from live feed if both are off
    const sniperConfig = await sniperRepo.getOrCreateConfig(ctx.from.id);
    if (!sniperConfig.enabled) liveFeedSubscribers.delete(ctx.from.id);
  }

  await ctx.answerCallbackQuery({
    text: newActive ? '✅ Trending Autopilot AKTIF!' : '⏸ Trending Autopilot DINONAKTIFKAN.',
  });

  await handleAutopilotMenu(ctx, autopilotRepo, sniperRepo);
}

export async function handleSniperToggle(
  ctx: Context,
  sniperRepo: SniperRepository,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await sniperRepo.getOrCreateConfig(ctx.from.id);
  const newActive = !config.enabled;
  await sniperRepo.updateConfig(ctx.from.id, { enabled: newActive });

  if (newActive) {
    liveFeedSubscribers.add(ctx.from.id);
  } else {
    // Only delete from live feed if both are off
    const autoConfig = await autopilotRepo.getOrCreateConfig(ctx.from.id);
    if (!autoConfig.is_active) liveFeedSubscribers.delete(ctx.from.id);
  }

  await ctx.answerCallbackQuery({
    text: newActive ? '⚡ New Token Sniper AKTIF!' : '🔴 New Token Sniper DINONAKTIFKAN.',
  });

  await handleAutopilotMenu(ctx, autopilotRepo, sniperRepo);
}

export async function handleAutopilotLogs(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const logs = await autopilotRepo.getRecentDecisionLogs(ctx.from.id, 5);
  let text = '📜 <b>Log Keputusan Autopilot</b>\n───────────────────────────\n\n';

  if (logs.length === 0) {
    text += '<i>Belum ada log keputusan yang tercatat.</i>';
  } else {
    for (const log of logs) {
      const icon = log.action === 'BUY' ? '🟢' : log.action === 'SKIP' ? '⚪' : '🔴';
      const actionLabel = log.action === 'BUY' ? 'BUY SIGNAL' : log.action;
      const strategyName = log.strategy === 'NEW_TOKEN_SNIPER' ? '⚡ SNIPER' : '📈 TRENDING';
      text += `${icon} <b>${actionLabel}</b> [${strategyName}] <code>${escapeHtml(log.token_symbol || log.token_mint.slice(0, 8))}</code>\n`;
      text += `├ <b>Score:</b> <code>${log.safety_score}/100</code> 🛡️\n`;
      
      if (log.safety_flags && log.safety_flags.length > 0) {
        text += `├ <b>Flags:</b> ${log.safety_flags.length > 2 ? log.safety_flags.slice(0, 2).map(escapeHtml).join(', ') + ', dll' : log.safety_flags.map(escapeHtml).join(', ')}\n`;
      }
      
      text += `└ <b>Catatan:</b> <i>${escapeHtml(log.reason_summary)}</i>\n\n`;
    }
  }

  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
  text += `───────────────────────────\n• <i>Diperbarui: ${timestamp}</i>`;

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh Log', 'autopilot_logs')
    .text('🤖 Autopilot Hub', 'menu_autopilot')
    .row()
    .text('🏠 Dashboard Utama', 'menu_main');

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
  const stats = await autopilotRepo.getStats(ctx.from.id);
  const pnlSign = stats.dailyRealizedPnlSol >= 0 ? '+' : '';
  const cbStatus = stats.isCircuitBroken ? '🔴 TERPICU' : '🟢 NORMAL';
  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
  
  const text = `
📊 <b>Statistik Kinerja Autopilot</b>
───────────────────────────
• <b>Total Trade Dieksekusi:</b> <b>${stats.totalTrades} Trade</b>
• <b>Realized PnL (Hari Ini):</b> <code>${pnlSign}${stats.dailyRealizedPnlSol.toFixed(4)} SOL</code>
• <b>Circuit Breaker Status:</b> ${cbStatus}
───────────────────────────
🕒 <i>Diperiksa pada: ${timestamp}</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh', 'autopilot_stats')
    .text('🤖 Autopilot Hub', 'menu_autopilot')
    .row()
    .text('🏠 Dashboard Utama', 'menu_main');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {}
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
