import { logger } from '../../utils/logger';
import { Bot, InlineKeyboard } from 'grammy';
import { UserRepository } from '../../database/repositories/userRepository';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { SniperRepository } from '../../database/repositories/sniperRepository';
import { TradeRepository } from '../../database/repositories/tradeRepository';
import { WalletService } from '../wallet/walletService';
import { ScannerService } from '../scanner/scannerService';
import { SecurityFilterService } from '../security/securityFilterService';
import { AnalyzerService } from '../analyzer/analyzerService';
import { TraderService } from '../trader/traderService';
import { getRedisConnection } from '../../queue/connection';
import { handleStartCommand } from './handlers/startHandler';
import { handleDashboardMenu } from './handlers/dashboardHandler';
import { currencyService } from '../../utils/currencyService';
import { getEnv } from '../../config/env';
import { liveFeedSubscribers } from '../scanner/liveFeedState';
import {
  handleWalletMenu,
  handleWalletRefresh,
  handleWalletWithdrawPrompt,
  handleWalletWithdrawConfirm,
  handleWalletWithdrawExecute,
  handleWalletExportPrompt,
  handleWalletExportExecute,
} from './handlers/walletHandler';
import { handleScanCommand } from './handlers/scanHandler';
import {
  handleAutopilotMenu,
  handleAutopilotToggle,
  handleSniperToggle,
  handleAutopilotLogs,
  handleAutopilotStats,
} from './handlers/autopilotHandler';
import { handleSettingsMenu } from './handlers/settingsHandler';
import { handleSniperSettings } from './handlers/sniperHandler';
import { handlePositionsMenu, handlePositionDetail } from './handlers/positionsHandler';
import { handleHelpMenu } from './handlers/helpHandler';
import { handleReportCommand } from './handlers/reportHandler';
import { createMainMenuKeyboard } from './formatters/keyboardBuilder';
import { escapeHtml } from './formatters/messageFormatter';

export interface BotRouteServices {
  userRepo: UserRepository;
  autopilotRepo: AutopilotRepository;
  sniperRepo: SniperRepository;
  walletService: WalletService;
  scannerService: ScannerService;
  securityService: SecurityFilterService;
  analyzerService: AnalyzerService;
  tradeRepo: TradeRepository;
  traderService: TraderService;
}

function cyclePreset(current: number, presets: readonly number[]): number {
  const index = presets.indexOf(Number(current));
  return presets[(index + 1) % presets.length];
}
function parsePositiveDecimal(input: string, max = 1000): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(input.trim())) return null;
  const value = Number(input);
  return Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

function parsePercent(input: string): number | null {
  const value = parsePositiveDecimal(input, 100);
  return value === null || value > 100 ? null : value;
}

export function registerBotRoutes(
  bot: Bot,
  services: BotRouteServices
): void {
  // Command /start
  bot.command('start', async (ctx) => {
    await handleStartCommand(ctx, services.userRepo, services.walletService);
  });

  // Command /dashboard
  bot.command('dashboard', async (ctx) => {
    await handleDashboardMenu(ctx, services.userRepo, services.autopilotRepo, services.tradeRepo, services.walletService);
  });

  // Command /wallet
  bot.command('wallet', async (ctx) => {
    await handleWalletMenu(ctx, services.walletService);
  });

  // Command /autopilot
  bot.command('autopilot', async (ctx) => {
    await handleAutopilotMenu(ctx, services.autopilotRepo, services.sniperRepo);
  });

  // Command /settings
  bot.command('settings', async (ctx) => {
    await handleSettingsMenu(ctx, services.autopilotRepo);
  });

  // Command /positions
  bot.command('positions', async (ctx) => {
    await handlePositionsMenu(ctx, services.tradeRepo, services.scannerService);
  });

  // Command /help
  bot.command('help', async (ctx) => {
    await handleHelpMenu(ctx);
  });

  // Command /report
  bot.command('report', async (ctx) => {
    await handleReportCommand(ctx, services.tradeRepo);
  });

  // Command /killswitch
  bot.command('killswitch', async (ctx) => {
    if (!ctx.from) return;
    const adminIds = getEnv().ADMIN_USER_IDS.split(',').map(id => id.trim());
    if (!adminIds.includes(ctx.from.id.toString())) {
      await ctx.reply('⚠️ Anda tidak memiliki akses untuk perintah ini.');
      return;
    }

    const match = ctx.match?.trim().toLowerCase();
    if (match !== 'on' && match !== 'off') {
      await ctx.reply('⚠️ Gunakan format: <code>/killswitch on</code> atau <code>/killswitch off</code>', { parse_mode: 'HTML' });
      return;
    }

    const redis = getRedisConnection();
    // Use dynamic import or existing logger if available for audit log, for now console/logger
    if (match === 'on') {
      await redis.set('killswitch:global', '1');
      logger.warn(`[AUDIT] Admin ${ctx.from.id} activated global killswitch.`);
      await ctx.reply('🛑 <b>KILL-SWITCH DIAKTIFKAN.</b> Semua entry baru ditolak.', { parse_mode: 'HTML' });
    } else {
      await redis.del('killswitch:global');
      logger.warn(`[AUDIT] Admin ${ctx.from.id} deactivated global killswitch.`);
      await ctx.reply('🟢 <b>KILL-SWITCH DINONAKTIFKAN.</b> Trading berjalan normal.', { parse_mode: 'HTML' });
    }
  });

  // Command /scan <CA>
  bot.command('scan', async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply(
        '⚠️ Harap sertakan Contract Address (CA).\nContoh: <code>/scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }
    await handleScanCommand(ctx, text, services.scannerService, services.securityService, services.analyzerService, services.autopilotRepo);
  });

  // Command /set_withdraw_address
  bot.command('set_withdraw_address', async (ctx) => {
    if (!ctx.from) return;
    const match = ctx.match?.trim();
    if (!match) {
      await ctx.reply('⚠️ Format salah. Gunakan: <code>/set_withdraw_address &lt;ALAMAT_SOLANA_ANDA&gt;</code>', { parse_mode: 'HTML' });
      return;
    }
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!solanaAddressRegex.test(match)) {
      await ctx.reply('⚠️ Alamat Solana tidak valid.');
      return;
    }
    
    const success = await services.walletService.updateOwnerPubkey(ctx.from.id, match);
    if (success) {
      const redis = getRedisConnection();
      const cooldownKey = `withdraw_cooldown:${ctx.from.id}`;
      // Set 24 hours cooldown for security
      await redis.set(cooldownKey, '1', 'EX', 24 * 3600);
      
      await ctx.reply(`✅ <b>Alamat Penarikan Tersimpan!</b>\n\nSemua withdrawal kini akan dikirim HANYA ke:\n<code>${match}</code>\n\n⚠️ <i>Demi keamanan, penarikan ditangguhkan selama 24 jam setelah perubahan alamat.</i>`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('❌ Gagal menyimpan alamat penarikan. Pastikan Anda sudah membuat wallet (/wallet).');
    }
  });

  // Command /withdraw
  bot.command('withdraw', async (ctx) => {
    if (!ctx.from) return;
    const match = ctx.match?.trim();
    if (!match) {
      await handleWalletWithdrawPrompt(ctx, services.walletService);
      return;
    }
    
    // Check if owner_pubkey exists
    const wallet = await services.walletService.getWalletRecord(ctx.from.id);
    
    if (!wallet || !wallet.owner_pubkey) {
      await ctx.reply('⚠️ <b>Alamat Penarikan Belum Diatur!</b>\n\nDemi keamanan, Anda harus mendaftarkan alamat wallet penerima Anda terlebih dahulu menggunakan perintah:\n<code>/set_withdraw_address &lt;ALAMAT_SOLANA_ANDA&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    const redis = getRedisConnection();
    const cooldownKey = `withdraw_cooldown:${ctx.from.id}`;
    const inCooldown = await redis.get(cooldownKey);
    if (inCooldown) {
      const ttl = await redis.ttl(cooldownKey);
      const hours = Math.floor(ttl / 3600);
      const minutes = Math.floor((ttl % 3600) / 60);
      await ctx.reply(`⚠️ <b>Penarikan Ditangguhkan!</b>\n\nAlamat penarikan Anda baru saja diubah. Demi keamanan, Anda harus menunggu <b>${hours} jam ${minutes} menit</b> lagi sebelum dapat melakukan penarikan.`, { parse_mode: 'HTML' });
      return;
    }

    const amountStr = match.toUpperCase();
    
    const amount = amountStr === 'MAX' ? 'MAX' : parsePositiveDecimal(amountStr);
    if (amount !== 'MAX' && amount === null) {
      await ctx.reply('⚠️ Jumlah tidak valid. Masukkan angka yang benar atau MAX.', { parse_mode: 'HTML' });
      return;
    }

    await handleWalletWithdrawConfirm(ctx, wallet.owner_pubkey, amount, services.walletService);
  });

  // Command /export_key
  bot.command('export_key', async (ctx) => {
    const match = ctx.match?.trim();
    if (match === 'SAYA_MENGERTI_RISIKONYA') {
      const redis = getRedisConnection();
      await handleWalletExportExecute(ctx, services.walletService, redis);
    } else {
      await ctx.reply('⚠️ Anda harus mengetik perintah konfirmasi dengan benar jika ingin mengekspor Private Key.');
    }
  });

  // Command /livefeed
  bot.command('livefeed', async (ctx) => {
    if (!ctx.from) return;
    
    if (liveFeedSubscribers.has(ctx.from.id)) {
      liveFeedSubscribers.delete(ctx.from.id);
      await ctx.reply('🔕 <b>Live Feed Dimatikan</b>\n\nAnda tidak akan menerima notifikasi saat Autopilot mem-bypass token.', { parse_mode: 'HTML' });
    } else {
      liveFeedSubscribers.add(ctx.from.id);
      await ctx.reply('🔔 <b>Live Feed Diaktifkan!</b>\n\nSistem akan mengirimkan laporan setiap kali Autopilot selesai memindai token-token trending di latar belakang (Setiap ~2 menit). \n\n<i>Ketik /livefeed lagi untuk mematikan.</i>', { parse_mode: 'HTML' });
    }
  });

  bot.on('message:text', async (ctx, next) => {
    if (!ctx.from) {
      await next();
      return;
    }
    const text = ctx.message.text.trim();

    const redis = getRedisConnection();
    const customBuyMint = await redis.get(`custom_buy_mint:${ctx.from.id}`);
    
    if (customBuyMint) {
      const amount = parsePositiveDecimal(text);
      if (amount === null) {
        await ctx.reply('⚠️ Harap masukkan angka yang valid (contoh: 0.1 atau 2). Transaksi Custom Buy dibatalkan.');
      } else {
        await ctx.reply(`⏳ Memproses order Custom Buy ${amount} SOL...`);
        await executeManualBuy(ctx, customBuyMint, amount, services);
      }
      await redis.del(`custom_buy_mint:${ctx.from.id}`);
      return;
    }

    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (solanaAddressRegex.test(text) && !text.startsWith('/')) {
      await handleScanCommand(ctx, text, services.scannerService, services.securityService, services.analyzerService, services.autopilotRepo);
      return;
    }
    await next();
  });

  // Callback query handling
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    // 1. Navigation Menus
    if (data === 'menu_main') {
      await ctx.answerCallbackQuery();
      await handleDashboardMenu(ctx, services.userRepo, services.autopilotRepo, services.tradeRepo, services.walletService);
    } else if (data === 'menu_wallet') {
      await ctx.answerCallbackQuery();
      await handleWalletMenu(ctx, services.walletService);
    } else if (data === 'menu_autopilot') {
      await ctx.answerCallbackQuery();
      await handleAutopilotMenu(ctx, services.autopilotRepo, services.sniperRepo);
    } else if (data === 'menu_settings' || data === 'autopilot_settings') {
      await ctx.answerCallbackQuery();
      await handleSettingsMenu(ctx, services.autopilotRepo);
    } else if (data === 'sniper_settings') {
      await ctx.answerCallbackQuery();
      await handleSniperSettings(ctx, services.sniperRepo);
    } else if (data === 'menu_positions') {
      await ctx.answerCallbackQuery();
      await handlePositionsMenu(ctx, services.tradeRepo, services.scannerService);
    } else if (data.startsWith('view_pos:')) {
      const tradeId = data.substring(9);
      await ctx.answerCallbackQuery();
      await handlePositionDetail(ctx, tradeId, services.tradeRepo, services.scannerService);
    } else if (data === 'menu_help') {
      await ctx.answerCallbackQuery();
      await handleHelpMenu(ctx);
    } else if (data === 'menu_scan') {
      await ctx.answerCallbackQuery();
      const text = (
        '🔍 <b>Scan Token Solana</b>\n\n' +
        'Silakan kirimkan <b>Contract Address (CA)</b> token Solana di chat ini, atau gunakan perintah:\n' +
        '<code>/scan &lt;CA&gt;</code>\n\n' +
        '<i>Contoh: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</i>'
      );
      const keyboard = new InlineKeyboard().text('🏠 Menu Utama', 'menu_main');
      const isPhoto = ctx.callbackQuery?.message && 'caption' in ctx.callbackQuery.message;
      try {
        if (isPhoto) {
          await ctx.editMessageCaption({
            caption: text,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } else {
          await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        }
      } catch (err: any) {
        if (err?.description?.includes('message is not modified')) return;
      }
    }

    // 2. Wallet Actions
    else if (data === 'wallet_refresh') {
      await ctx.answerCallbackQuery({ text: '🔄 Memperbarui saldo...' });
      await handleWalletRefresh(ctx, services.walletService);
    } else if (data === 'wallet_withdraw') {
      await ctx.answerCallbackQuery();
      await handleWalletWithdrawPrompt(ctx, services.walletService);
    } else if (data.startsWith('withdraw_pct:')) {
      const pct = data.substring(13);
      await ctx.answerCallbackQuery();
      if (!ctx.from) return;
      const wallet = await services.walletService.getWalletRecord(ctx.from.id);
      if (!wallet || !wallet.owner_pubkey) {
         await ctx.reply('⚠️ Alamat penarikan belum diatur.');
         return;
      }
      
      let amount: number | 'MAX' = 'MAX';
      if (pct !== 'MAX') {
         const pctNum = parsePercent(pct);
         if (pctNum === null) {
           await ctx.reply('⚠️ Persentase withdrawal tidak valid.');
           return;
         }
         const balance = await services.walletService.getBalance(wallet.public_key);
         // leaves some room for gas (e.g. 0.002) if we were smart, but since it's a percentage of balance,
         // the percentage will be calculated. 
         const computed = (balance.sol * pctNum) / 100;
         amount = Math.max(0, computed - 0.005); // reserve gas
      }
      
      if (amount !== 'MAX' && amount <= 0) {
        await ctx.reply('⚠️ Saldo terlalu kecil untuk ditarik setelah dikurangi biaya gas (0.005 SOL).');
        return;
      }

      await handleWalletWithdrawConfirm(ctx, wallet.owner_pubkey, amount, services.walletService);
    } else if (data.startsWith('wd_exec:')) {
      const withdrawalId = data.substring(8);
      await ctx.answerCallbackQuery({ text: '⏳ Memproses penarikan...' });
      const redis = getRedisConnection();
      await handleWalletWithdrawExecute(ctx, withdrawalId, services.walletService, redis);
    } else if (data.startsWith('withdraw_cancel')) {
      if (data.startsWith('withdraw_cancel:') && ctx.from) {
        const withdrawalId = data.substring('withdraw_cancel:'.length);
        await services.walletService['walletRepo'].cancelAuthorizedWithdrawal(withdrawalId, ctx.from.id);
      }
      await ctx.answerCallbackQuery({ text: 'Penarikan dibatalkan.' });
      await handleWalletMenu(ctx, services.walletService);
    } else if (data === 'wallet_export') {
      await ctx.answerCallbackQuery();
      await handleWalletExportPrompt(ctx);
    }

    // 3. Autopilot Actions
    else if (data === 'autopilot_toggle') {
      const cfg = await services.autopilotRepo.getOrCreateConfig(ctx.from.id);
      if (!cfg.is_active && cfg.mode === 'LIVE' && !getEnv().LIVE_TRADING_ENABLED) {
        await ctx.answerCallbackQuery({
          text: '⚠️ LIVE TRADING saat ini dinonaktifkan secara global demi keamanan.',
          show_alert: true,
        });
        return;
      }
      await handleAutopilotToggle(ctx, services.autopilotRepo, services.sniperRepo);
    } else if (data === 'sniper_toggle') {
      await handleSniperToggle(ctx, services.sniperRepo, services.autopilotRepo);
    } else if (data === 'autopilot_toggle_trending') {
      if (!ctx.from) return;
      const cfg = await services.autopilotRepo.getOrCreateConfig(ctx.from.id);
      const trendingEnabled = (cfg.safety_params as any)?.enable_trending !== false;
      await services.autopilotRepo.updateConfig(ctx.from.id, {
        safety_params: { ...cfg.safety_params, enable_trending: !trendingEnabled },
      });
      await ctx.answerCallbackQuery({ text: `Trending Scanner ${!trendingEnabled ? 'Diaktifkan' : 'Dinonaktifkan'}` });
      await handleAutopilotMenu(ctx, services.autopilotRepo, services.sniperRepo);
    } else if (data === 'autopilot_toggle_sniper') {
      if (!ctx.from) return;
      const cfg = await services.sniperRepo.getOrCreateConfig(ctx.from.id);
      await services.sniperRepo.updateConfig(ctx.from.id, { enabled: !cfg.enabled });
      await ctx.answerCallbackQuery({ text: `Sniper ${!cfg.enabled ? 'Enabled' : 'Disabled'}` });
      await handleAutopilotMenu(ctx, services.autopilotRepo, services.sniperRepo);
    } else if (data === 'autopilot_logs') {
      await ctx.answerCallbackQuery();
      await handleAutopilotLogs(ctx, services.autopilotRepo);
    } else if (data === 'autopilot_stats') {
      await ctx.answerCallbackQuery();
      await handleAutopilotStats(ctx, services.autopilotRepo);
    }

    // 4. Settings Actions
    else if (data === 'sniper_settings_mode') {
      if (!ctx.from) return;
      const cfg = await services.sniperRepo.getOrCreateConfig(ctx.from.id);
      const newMode = cfg.trading_mode === 'PAPER' ? 'LIVE' : 'PAPER';

      if (newMode === 'LIVE' && !getEnv().LIVE_TRADING_ENABLED) {
        await ctx.answerCallbackQuery({
          text: '⚠️ LIVE TRADING saat ini dinonaktifkan secara global demi keamanan.',
          show_alert: true,
        });
        return;
      }

      await services.sniperRepo.updateConfig(ctx.from.id, { trading_mode: newMode });
      await ctx.answerCallbackQuery({
        text: `Mode diubah ke: ${newMode === 'PAPER' ? '🟢 PAPER TRADING (Simulasi)' : '⚡ LIVE ON-CHAIN'}`,
      });
      await handleSniperSettings(ctx, services.sniperRepo);
    } else if (data === 'sniper_settings_amount') {
      if (!ctx.from) return;
      const cfg = await services.sniperRepo.getOrCreateConfig(ctx.from.id);
      const current = cfg.buy_amount_sol;
      const next = cyclePreset(current, [0.005, 0.01, 0.02, 0.03]);
      await services.sniperRepo.updateConfig(ctx.from.id, { buy_amount_sol: next });
      await ctx.answerCallbackQuery({ text: `Buy Amount diubah ke ${next} SOL` });
      await handleSniperSettings(ctx, services.sniperRepo);
    } else if (data === 'sniper_settings_tp') {
       if (!ctx.from) return;
       const cfg = await services.sniperRepo.getOrCreateConfig(ctx.from.id);
       const current = cfg.take_profit_percent;
       const next = cyclePreset(current, [10, 20, 25, 50, 100]);
       await services.sniperRepo.updateConfig(ctx.from.id, { take_profit_percent: next });
       await ctx.answerCallbackQuery({ text: `Take Profit diubah ke ${next}%` });
       await handleSniperSettings(ctx, services.sniperRepo);
    } else if (data === 'sniper_settings_sl') {
       if (!ctx.from) return;
       const cfg = await services.sniperRepo.getOrCreateConfig(ctx.from.id);
       const current = cfg.stop_loss_percent;
       const next = cyclePreset(current, [5, 8, 10, 15, 20]);
       await services.sniperRepo.updateConfig(ctx.from.id, { stop_loss_percent: next });
       await ctx.answerCallbackQuery({ text: `Stop Loss diubah ke ${next}%` });
       await handleSniperSettings(ctx, services.sniperRepo);
    } else if (data.startsWith('sniper_settings_') && [
      'sniper_settings_positions', 'sniper_settings_daily_buys', 'sniper_settings_daily_budget',
      'sniper_settings_pool_age', 'sniper_settings_liquidity', 'sniper_settings_safety',
      'sniper_settings_slippage',
    ].includes(data)) {
      if (!ctx.from) return;
      const cfg = await services.sniperRepo.getOrCreateConfig(ctx.from.id);
      const mapping: Record<string, { field: keyof typeof cfg; presets: number[] }> = {
        sniper_settings_positions: {field:'max_active_positions',presets:[1,2,3]},
        sniper_settings_daily_buys: {field:'max_buys_per_day',presets:[1,2,3]},
        sniper_settings_daily_budget: {field:'max_daily_entry_budget_sol',presets:[0.01,0.02,0.03,0.05,0.1]},
        sniper_settings_pool_age: {field:'max_pool_age_minutes',presets:[1,3,5,10]},
        sniper_settings_liquidity: {field:'min_liquidity_usd',presets:[5000,10000,25000,50000]},
        sniper_settings_safety: {field:'minimum_safety_score',presets:[70,80,90,95]},
        sniper_settings_slippage: {field:'max_slippage_bps',presets:[50,100,150,200]},
      };
      const { field, presets } = mapping[data];
      const next = cyclePreset(Number(cfg[field]),presets);
      await services.sniperRepo.updateConfig(ctx.from.id, { [field]: next });
      await ctx.answerCallbackQuery({ text: `${field} set to ${next}` });
      await handleSniperSettings(ctx, services.sniperRepo);
    } else if (data === 'settings_toggle_mode') {
      if (!ctx.from) return;
      const cfg = await services.autopilotRepo.getOrCreateConfig(ctx.from.id);
      const newMode = cfg.mode === 'PAPER' ? 'LIVE' : 'PAPER';

      if (newMode === 'LIVE' && !getEnv().LIVE_TRADING_ENABLED) {
        await ctx.answerCallbackQuery({
          text: '⚠️ LIVE TRADING saat ini dinonaktifkan secara global demi keamanan.',
          show_alert: true,
        });
        return;
      }

      await services.autopilotRepo.updateConfig(ctx.from.id, { mode: newMode });
      await ctx.answerCallbackQuery({
        text: `Mode diubah ke: ${newMode === 'PAPER' ? '🟢 PAPER TRADING (Simulasi)' : '⚡ LIVE ON-CHAIN'}`,
      });
      await handleSettingsMenu(ctx, services.autopilotRepo);
    } else if (data.startsWith('settings_size_')) {
      if (!ctx.from) return;
      const size = parsePositiveDecimal(data.replace('settings_size_', ''), 1000);
      if (size === null) {
        await ctx.answerCallbackQuery({ text: 'Ukuran trade tidak valid', show_alert: true });
        return;
      }
      await services.autopilotRepo.updateConfig(ctx.from.id, {
        sizing_params: { fixed_sol: size },
      });
      await ctx.answerCallbackQuery({ text: `Trade size diubah ke ${size} SOL` });
      await handleSettingsMenu(ctx, services.autopilotRepo);
    } else if (data === 'settings_cycle_sl') {
      if (!ctx.from) return;
      const cfg = await services.autopilotRepo.getOrCreateConfig(ctx.from.id);
      const currentSl = (cfg.exit_params as any)?.sl_percent ?? 8;
      // Cycle: 5 -> 8 -> 10 -> 15 -> 20 -> 5
      const nextSl = currentSl === 5 ? 8 : currentSl === 8 ? 10 : currentSl === 10 ? 15 : currentSl === 15 ? 20 : 5;
      await services.autopilotRepo.updateConfig(ctx.from.id, {
        exit_params: { ...cfg.exit_params, sl_percent: nextSl },
      });
      await ctx.answerCallbackQuery({ text: `Stop Loss diubah ke ${nextSl}%` });
      await handleSettingsMenu(ctx, services.autopilotRepo);
    } else if (data === 'settings_cycle_tp') {
      if (!ctx.from) return;
      const cfg = await services.autopilotRepo.getOrCreateConfig(ctx.from.id);
      const currentTp = (cfg.exit_params as any)?.tp1_percent ?? 15;
      // Cycle: 10 -> 15 -> 20 -> 30 -> 50 -> 100 -> 10
      const nextTp = currentTp === 10 ? 15 : currentTp === 15 ? 20 : currentTp === 20 ? 30 : currentTp === 30 ? 50 : currentTp === 50 ? 100 : 10;
      await services.autopilotRepo.updateConfig(ctx.from.id, {
        exit_params: { ...cfg.exit_params, tp1_percent: nextTp },
      });
      await ctx.answerCallbackQuery({ text: `Take Profit diubah ke ${nextTp}%` });
      await handleSettingsMenu(ctx, services.autopilotRepo);
    } else if (data === 'settings_toggle_trailing') {
      if (!ctx.from) return;
      const cfg = await services.autopilotRepo.getOrCreateConfig(ctx.from.id);
      const trailingEnabled = (cfg.exit_params as any)?.trailing_stop_enabled || false;
      await services.autopilotRepo.updateConfig(ctx.from.id, {
        exit_params: { ...cfg.exit_params, trailing_stop_enabled: !trailingEnabled },
      });
      await ctx.answerCallbackQuery({ text: `Trailing Stop ${!trailingEnabled ? 'Diaktifkan' : 'Dinonaktifkan'}` });
      await handleSettingsMenu(ctx, services.autopilotRepo);
    } else if (data === 'settings_toggle_trending') {
      if (!ctx.from) return;
      const cfg = await services.autopilotRepo.getOrCreateConfig(ctx.from.id);
      await services.autopilotRepo.updateConfig(ctx.from.id, {
        is_active: !cfg.is_active,
        safety_params: { ...cfg.safety_params, enable_trending: !cfg.is_active },
      });
      await ctx.answerCallbackQuery({ text: `Trending ${!cfg.is_active ? 'Enabled' : 'Disabled'}` });
      await handleAutopilotMenu(ctx, services.autopilotRepo, services.sniperRepo);
    } else if (data === 'settings_toggle_sniper') {
      if (!ctx.from) return;
      const cfg = await services.sniperRepo.getOrCreateConfig(ctx.from.id);
      await services.sniperRepo.updateConfig(ctx.from.id, { enabled: !cfg.enabled });
      await ctx.answerCallbackQuery({ text: `Sniper ${!cfg.enabled ? 'Enabled' : 'Disabled'}` });
      await handleSniperSettings(ctx, services.sniperRepo);
    } else if (data === 'toggle_livefeed') {
      if (!ctx.from) return;
      if (liveFeedSubscribers.has(ctx.from.id)) {
        liveFeedSubscribers.delete(ctx.from.id);
        await ctx.answerCallbackQuery({ text: '🔕 Live Feed Dimatikan', show_alert: true });
      } else {
        liveFeedSubscribers.add(ctx.from.id);
        await ctx.answerCallbackQuery({ text: '🔔 Live Feed Diaktifkan', show_alert: true });
      }
    }

    // 5. Token Scan Actions
    else if (data.startsWith('refresh:')) {
      const tokenMint = data.split(':')[1];
      await handleScanCommand(ctx, tokenMint, services.scannerService, services.securityService, services.analyzerService, services.autopilotRepo);
    } else if (data.startsWith('buy_custom:')) {
      if (!ctx.from) return;
      const mint = data.split(':')[1];
      const redis = getRedisConnection();
      await redis.set(`custom_buy_mint:${ctx.from.id}`, mint, 'EX', 300); // 5 mins expiry
      
      await ctx.answerCallbackQuery();
      await ctx.reply(`✍️ <b>Custom Buy</b>\n\nBerapa SOL yang ingin dialokasikan untuk membeli CA: <code>${escapeHtml(mint)}</code>?\n\n<i>(Ketik angka saja, contoh: 1.5 atau 0.02)</i>`, {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true }
      });
    } else if (data.startsWith('buy:')) {
      if (!ctx.from) return;
      const [, mint, amountStr] = data.split(':');
      const amount = parsePositiveDecimal(amountStr);
      if (amount === null) {
        await ctx.answerCallbackQuery({ text: 'Jumlah order tidak valid', show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: `⏳ Memproses order ${amount} SOL...` });
      await executeManualBuy(ctx, mint, amount, services);
    } else if (data.startsWith('sell:')) {
      if (!ctx.from) return;
      const [, tradeId, percentStr] = data.split(':');
      const percent = parsePercent(percentStr);
      if (percent === null) {
        await ctx.answerCallbackQuery({ text: 'Persentase jual tidak valid', show_alert: true });
        return;
      }
      
      await ctx.answerCallbackQuery({ text: `⏳ Memproses penutupan posisi ${percent}%...` });
      
      try {
        const trade = await services.tradeRepo.getTradeById(tradeId);
        if (!trade || trade.user_id !== ctx.from.id) throw new Error('Posisi tidak ditemukan atau akses ditolak');
        
        const pair = await services.scannerService.scanTokenByAddress(trade.token_mint);
        const priceUsd = pair ? parseFloat(pair.priceUsd || '0') : 0;
        if (priceUsd === 0) throw new Error('Gagal mendapatkan harga terkini token');

        await services.traderService.closePosition(trade, priceUsd, percent);
        
        await currencyService.fetchRates();
        const entryPrice = trade.entry_price_usd;
        const pnlPercent = ((priceUsd - entryPrice) / entryPrice) * 100;
        const pnlSol = trade.sol_amount * (pnlPercent / 100) * (percent / 100);
        const pnlIdr = currencyService.solToIdr(pnlSol);
        const pnlIcon = pnlPercent > 0 ? '🟢' : pnlPercent < 0 ? '🔴' : '➖';

        await ctx.reply(
          `✅ <b>Posisi Berhasil Ditutup (${percent}%)!</b>\n\n` +
          `• <b>Token:</b> ${escapeHtml(trade.token_symbol)}\n` +
          `• <b>Entry Price:</b> $${entryPrice.toFixed(6)}\n` +
          `• <b>Exit Price:</b> $${priceUsd.toFixed(6)}\n` +
          `• <b>PnL:</b> ${pnlIcon} <b>${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b> (${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)\n` +
          `• <b>Profit/Loss:</b> ${pnlIdr !== null && pnlIdr > 0 ? '+' : ''}${currencyService.formatIdr(pnlIdr)}\n`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('📊 Cek Posisi', 'menu_positions')
              .text('🏠 Menu Utama', 'menu_main'),
          }
        );
        // Refresh positions list message
        await handlePositionsMenu(ctx, services.tradeRepo, services.scannerService);
      } catch (err: any) {
        await ctx.reply(`❌ <b>Gagal menutup posisi:</b> ${escapeHtml(err.message || 'Error tidak diketahui')}`, { parse_mode: 'HTML' });
      }
    } else {
      await ctx.answerCallbackQuery();
    }
  });
}

async function executeManualBuy(ctx: any, mint: string, amount: number, services: BotRouteServices) {
  try {
    const cfg = await services.autopilotRepo.getOrCreateConfig(ctx.from.id);
    const isDryRun = cfg.mode === 'PAPER';

    const pair = await services.scannerService.scanTokenByAddress(mint);
    const priceUsd = pair ? parseFloat(pair.priceUsd || '0') : 0.0001;
    const symbol = pair?.baseToken?.symbol || 'UNKNOWN';

    const trade = await services.traderService.executeOrder({
      userId: ctx.from.id,
      tokenMint: mint,
      tokenSymbol: symbol,
      solAmount: amount,
      currentPriceUsd: priceUsd,
      isDryRun,
      source: 'MANUAL',
    });

    await currencyService.fetchRates();
    const amountIdr = currencyService.solToIdr(amount);

    await ctx.reply(
      `✅ <b>Order Berhasil Dieksekusi!</b>\n\n` +
      `• <b>Mode:</b> ${isDryRun ? '🟢 PAPER TRADING (Simulasi)' : '⚡ LIVE ON-CHAIN'}\n` +
      `• <b>Token:</b> ${escapeHtml(symbol)} (<code>${escapeHtml(mint.slice(0, 8))}...</code>)\n` +
      `• <b>Alokasi:</b> <code>${amount} SOL</code> (${currencyService.formatIdr(amountIdr)})\n` +
      `• <b>Estimasi Token:</b> <code>${trade.token_amount.toFixed(2)}</code>\n` +
      `• <b>Entry Price:</b> $${priceUsd.toFixed(6)}\n` +
      `• <b>Status:</b> <code>${trade.status}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('📊 Cek Posisi', 'menu_positions')
          .text('🏠 Menu Utama', 'menu_main'),
      }
    );
  } catch (err: any) {
    await ctx.reply(`❌ <b>Gagal eksekusi order:</b> ${escapeHtml(err.message || 'Error tidak diketahui')}`, { parse_mode: 'HTML' });
  }
}
