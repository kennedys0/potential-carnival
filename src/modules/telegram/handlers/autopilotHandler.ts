import { Context, InlineKeyboard } from 'grammy';
import { AutopilotRepository } from '../../../database/repositories/autopilotRepository';
import { SniperRepository } from '../../../database/repositories/sniperRepository';
import { z } from 'zod';
import { liveFeedSubscribers } from '../../scanner/liveFeedState';

export async function handleAutopilotMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository,
  sniperRepo: SniperRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const sniperConfig = await sniperRepo.getOrCreateConfig(ctx.from.id);
  
  const trendingStatus = config.is_active ? '🟢 Running' : '⏸ Paused';
  const sniperStatus = sniperConfig.enabled ? '🟢 Running' : '🔴 Disabled';

  // In a real app we'd fetch actual open positions here for the stats
  const sizing = (config.sizing_params as any) || {};

  const text = `
🤖 <b>AUTOMATION CENTER</b>

<b>Trending Autopilot</b>
Status: ${trendingStatus}
Source: GeckoTerminal Trending
Buy Amount: ${sizing.fixed_sol ?? 0.1} SOL

<b>New Token Sniper</b>
Status: ${sniperStatus}
Source: Solana New Pools
Buy Amount: ${sniperConfig.buy_amount_sol} SOL
Max Buys/Day: ${sniperConfig.max_buys_per_day}

<i>Pilih strategi di bawah ini untuk mengonfigurasi.</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text(config.is_active ? '⏸ Trending OFF' : '▶️ Trending ON', 'autopilot_toggle')
    .text('⚙️ Trending Settings', 'autopilot_settings')
    .row()
    .text(sniperConfig.enabled ? '⏸ Sniper OFF' : '▶️ Sniper ON', 'sniper_toggle')
    .text('⚙️ Sniper Settings', 'sniper_settings')
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
  autopilotRepo: AutopilotRepository,
  sniperRepo: SniperRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const newActive = !config.is_active;
  await autopilotRepo.updateConfig(ctx.from.id, { is_active: newActive });

  if (newActive) {
    liveFeedSubscribers.add(ctx.from.id);
  } else {
    // Only delete from live feed if both are off
    const sniperConfig = await sniperRepo.getOrCreateConfig(ctx.from.id);
    if (!sniperConfig.enabled) liveFeedSubscribers.delete(ctx.from.id);
  }

  await ctx.answerCallbackQuery({
    text: newActive ? '✅ Trending Autopilot ON!' : '⏸ Trending Autopilot OFF.',
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
    text: newActive ? '✅ New Token Sniper ON!' : '🔴 New Token Sniper OFF.',
  });

  await handleAutopilotMenu(ctx, autopilotRepo, sniperRepo);
}

export async function handleAutopilotLogs(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const logs = await autopilotRepo.getRecentDecisionLogs(ctx.from.id, 5);
  let text = '📜 <b>Log Keputusan Autopilot</b>\n\n';

  if (logs.length === 0) {
    text += '<i>Belum ada log keputusan yang tercatat.</i>';
  } else {
    for (const log of logs) {
      const icon = log.action === 'BUY' ? '🟢' : log.action === 'SKIP' ? '⚪' : '🔴';
      const strategyName = log.strategy === 'NEW_TOKEN_SNIPER' ? '⚡ SNIPER' : '📈 TRENDING';
      text += `${icon} <b>${log.action}</b> [${strategyName}] <code>${log.token_symbol || log.token_mint.slice(0, 8)}</code>\n`;
      text += `├ <b>Score:</b> ${log.safety_score}/100 🛡️\n`;
      
      if (log.safety_flags && log.safety_flags.length > 0) {
        text += `├ <b>Flags:</b> ${log.safety_flags.length > 2 ? log.safety_flags.slice(0, 2).join(', ') + ', dll' : log.safety_flags.join(', ')}\n`;
      }
      
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
  // Simplified for brevity, same as before
  if (!ctx.from) return;
  const stats = await autopilotRepo.getStats(ctx.from.id);
  const pnlSign = stats.dailyRealizedPnlSol >= 0 ? '+' : '';
  const cbStatus = stats.isCircuitBroken ? '🔴 AKTIF' : '🟢 NORMAL';
  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
  
  const text = `
📊 <b>Statistik Kinerja</b>

• <b>Total Trade Dieksekusi:</b> ${stats.totalTrades}
• <b>Realized PnL (hari ini):</b> ${pnlSign}${stats.dailyRealizedPnlSol.toFixed(4)} SOL
• <b>Circuit Breaker:</b> ${cbStatus}
• <i>Diperiksa pada: ${timestamp}</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh', 'autopilot_stats')
    .text('🤖 Dashboard Autopilot', 'menu_autopilot')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {}
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
