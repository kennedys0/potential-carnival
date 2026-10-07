import { logger } from '../../utils/logger';
import { Bot, InlineKeyboard } from 'grammy';
import { UserRepository } from '../../database/repositories/userRepository';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { TradeRepository } from '../../database/repositories/tradeRepository';
import { WalletService } from '../wallet/walletService';
import { ScannerService } from '../scanner/scannerService';
import { SecurityFilterService } from '../security/securityFilterService';
import { AnalyzerService } from '../analyzer/analyzerService';
import { TraderService } from '../trader/traderService';
import { getRedisConnection } from '../../queue/connection';
import { handleStartCommand } from './handlers/startHandler';
import { currencyService } from '../../utils/currencyService';
import { getEnv } from '../../config/env';
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
  handleAutopilotPreset,
  handleAutopilotLogs,
  handleAutopilotStats,
} from './handlers/autopilotHandler';
import { handleSettingsMenu } from './handlers/settingsHandler';
import { handlePositionsMenu } from './handlers/positionsHandler';
import { handleHelpMenu } from './handlers/helpHandler';
import { createMainMenuKeyboard } from './formatters/keyboardBuilder';

export interface BotRouteServices {
  userRepo: UserRepository;
  autopilotRepo: AutopilotRepository;
  walletService: WalletService;
  scannerService: ScannerService;
  securityService: SecurityFilterService;
  analyzerService: AnalyzerService;
  tradeRepo: TradeRepository;
  traderService: TraderService;
}

export function registerBotRoutes(
  bot: Bot,
  services: BotRouteServices
): void {
  // Command /start
  bot.command('start', async (ctx) => {
    await handleStartCommand(ctx, services.userRepo, services.walletService);
  });

  // Command /wallet
  bot.command('wallet', async (ctx) => {
    await handleWalletMenu(ctx, services.walletService);
  });

  // Command /autopilot
  bot.command('autopilot', async (ctx) => {
    await handleAutopilotMenu(ctx, services.autopilotRepo);
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
    await handleScanCommand(ctx, text, services.scannerService, services.securityService, services.analyzerService);
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
    
    // We update the owner_pubkey directly using the supabase client via repo, or better via walletService.
    // Let's import walletRepository here or call walletService if we add the method.
    // I will use walletService.setOwnerPubkey if it existed, but we didn't add it to WalletService yet.
    // Wait, let's inject walletRepo in BotRouteServices or use walletService.
    const { getSupabaseClient } = await import('../../database/client.js');
    const { WalletRepository } = await import('../../database/repositories/walletRepository.js');
    const db = getSupabaseClient();
    const walletRepo = new WalletRepository(db);
    
    const success = await walletRepo.updateOwnerPubkey(ctx.from.id, match);
    if (success) {
      await ctx.reply(`✅ <b>Alamat Penarikan Tersimpan!</b>\n\nSemua withdrawal kini akan dikirim HANYA ke:\n<code>${match}</code>`, { parse_mode: 'HTML' });
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
    const { getSupabaseClient } = await import('../../database/client.js');
    const { WalletRepository } = await import('../../database/repositories/walletRepository.js');
    const db = getSupabaseClient();
    const walletRepo = new WalletRepository(db);
    const wallet = await walletRepo.getWalletByUserId(ctx.from.id);
    
    if (!wallet || !wallet.owner_pubkey) {
      await ctx.reply('⚠️ <b>Alamat Penarikan Belum Diatur!</b>\n\nDemi keamanan, Anda harus mendaftarkan alamat wallet penerima Anda terlebih dahulu menggunakan perintah:\n<code>/set_withdraw_address &lt;ALAMAT_SOLANA_ANDA&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    const amountStr = match.toUpperCase();
    
    const amount = amountStr === 'MAX' ? 'MAX' : parseFloat(amountStr);
    if (amount !== 'MAX' && (isNaN(amount) || amount <= 0)) {
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
    
    // We import liveFeedSubscribers dynamically because router.ts is imported in index.ts which imports trendScanner.ts.
    // To avoid circular dependency issues, we can just require it
    const { liveFeedSubscribers } = await import('../scanner/trendScanner.js');
    
    if (liveFeedSubscribers.has(ctx.from.id)) {
      liveFeedSubscribers.delete(ctx.from.id);
      await ctx.reply('🔕 <b>Live Feed Dimatikan</b>\n\nAnda tidak akan menerima notifikasi saat Autopilot mem-bypass token.', { parse_mode: 'HTML' });
    } else {
      liveFeedSubscribers.add(ctx.from.id);
      await ctx.reply('🔔 <b>Live Feed Diaktifkan!</b>\n\nSistem akan mengirimkan laporan setiap kali Autopilot selesai memindai token-token trending di latar belakang (Setiap ~2 menit). \n\n<i>Ketik /livefeed lagi untuk mematikan.</i>', { parse_mode: 'HTML' });
    }
  });

  // Auto-detect Contract Address sent directly in text chat (Solana Base58 address format: 32-44 characters)
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (solanaAddressRegex.test(text) && !text.startsWith('/')) {
      await handleScanCommand(ctx, text, services.scannerService, services.securityService, services.analyzerService);
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
      const text = '🏠 <b>Menu Utama Solana Scalping Bot</b>\nPilih salah satu aksi di bawah untuk melanjutkan:';
      const isPhoto = ctx.callbackQuery?.message && 'caption' in ctx.callbackQuery.message;
      try {
        if (isPhoto) {
          await ctx.editMessageCaption({
            caption: text,
            parse_mode: 'HTML',
            reply_markup: createMainMenuKeyboard(),
          });
        } else {
          await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: createMainMenuKeyboard(),
          });
        }
      } catch (err: any) {
        if (err?.description?.includes('message is not modified')) return;
      }
    } else if (data === 'menu_wallet') {
      await ctx.answerCallbackQuery();
      await handleWalletMenu(ctx, services.walletService);
    } else if (data === 'menu_autopilot') {
      await ctx.answerCallbackQuery();
      await handleAutopilotMenu(ctx, services.autopilotRepo);
    } else if (data === 'menu_settings') {
      await ctx.answerCallbackQuery();
      await handleSettingsMenu(ctx, services.autopilotRepo);
    } else if (data === 'menu_positions') {
      await ctx.answerCallbackQuery();
      await handlePositionsMenu(ctx, services.tradeRepo, services.scannerService);
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
    } else if (data.startsWith('withdraw_execute:')) {
      const [, address, amount] = data.split(':');
      await ctx.answerCallbackQuery({ text: '⏳ Memproses penarikan...' });
      await handleWalletWithdrawExecute(ctx, address, amount, services.walletService);
    } else if (data === 'withdraw_cancel') {
      await ctx.answerCallbackQuery({ text: '❌ Penarikan dibatalkan.' });
      await handleWalletMenu(ctx, services.walletService);
    } else if (data === 'wallet_export') {
      await ctx.answerCallbackQuery();
      await handleWalletExportPrompt(ctx);
    }

    // 3. Autopilot Actions
    else if (data === 'autopilot_toggle') {
      await handleAutopilotToggle(ctx, services.autopilotRepo);
    } else if (data === 'preset_conservative') {
      await handleAutopilotPreset(ctx, 'CONSERVATIVE', services.autopilotRepo);
    } else if (data === 'preset_moderate') {
      await handleAutopilotPreset(ctx, 'MODERATE', services.autopilotRepo);
    } else if (data === 'preset_aggressive') {
      await handleAutopilotPreset(ctx, 'AGGRESSIVE', services.autopilotRepo);
    } else if (data === 'autopilot_logs') {
      await ctx.answerCallbackQuery();
      await handleAutopilotLogs(ctx, services.autopilotRepo);
    } else if (data === 'autopilot_stats') {
      await ctx.answerCallbackQuery();
      await handleAutopilotStats(ctx, services.autopilotRepo);
    }

    // 4. Settings Actions
    else if (data === 'settings_toggle_mode') {
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
      const size = parseFloat(data.replace('settings_size_', '')) ?? 0.1;
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
    }

    // 5. Token Scan Actions
    else if (data.startsWith('refresh:')) {
      const tokenMint = data.split(':')[1];
      await handleScanCommand(ctx, tokenMint, services.scannerService, services.securityService, services.analyzerService);
    } else if (data.startsWith('buy:')) {
      if (!ctx.from) return;
      const [, mint, amountStr] = data.split(':');
      const amount = parseFloat(amountStr) ?? 0.1;

      await ctx.answerCallbackQuery({ text: `⏳ Memproses order ${amount} SOL...` });

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
        const amountIdr = amount * currencyService.getIdrPerSol();

        await ctx.reply(
          `✅ <b>Order Berhasil Dieksekusi!</b>\n\n` +
          `• <b>Mode:</b> ${isDryRun ? '🟢 PAPER TRADING (Simulasi)' : '⚡ LIVE ON-CHAIN'}\n` +
          `• <b>Token:</b> ${symbol} (<code>${mint.slice(0, 8)}...</code>)\n` +
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
        await ctx.reply(`❌ <b>Gagal eksekusi order:</b> ${err.message}`, { parse_mode: 'HTML' });
      }
    } else if (data.startsWith('sell:')) {
      if (!ctx.from) return;
      const [, tradeId, percentStr] = data.split(':');
      const percent = parseFloat(percentStr) ?? 100;
      
      await ctx.answerCallbackQuery({ text: `⏳ Memproses penutupan posisi ${percent}%...` });
      
      try {
        const trade = await services.tradeRepo.getTradeById(tradeId);
        if (!trade || trade.user_id !== ctx.from.id) throw new Error('Posisi tidak ditemukan atau akses ditolak');
        
        const pair = await services.scannerService.scanTokenByAddress(trade.token_mint);
        const priceUsd = pair ? parseFloat(pair.priceUsd || '0') : 0;
        if (priceUsd === 0) throw new Error('Gagal mendapatkan harga terkini token');

        await services.traderService.closePosition(trade, priceUsd, percent);
        
        await currencyService.fetchRates();
        const idrPerSol = currencyService.getIdrPerSol();
        
        const entryPrice = trade.entry_price_usd;
        const pnlPercent = ((priceUsd - entryPrice) / entryPrice) * 100;
        const pnlSol = trade.sol_amount * (pnlPercent / 100) * (percent / 100);
        const pnlIdr = pnlSol * idrPerSol;
        const pnlIcon = pnlPercent > 0 ? '🟢' : pnlPercent < 0 ? '🔴' : '➖';

        await ctx.reply(
          `✅ <b>Posisi Berhasil Ditutup (${percent}%)!</b>\n\n` +
          `• <b>Token:</b> ${trade.token_symbol}\n` +
          `• <b>Entry Price:</b> $${entryPrice.toFixed(6)}\n` +
          `• <b>Exit Price:</b> $${priceUsd.toFixed(6)}\n` +
          `• <b>PnL:</b> ${pnlIcon} <b>${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b> (${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)\n` +
          `• <b>Profit/Loss:</b> ${pnlIdr > 0 ? '+' : ''}${currencyService.formatIdr(pnlIdr)}\n`,
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
        await ctx.reply(`❌ <b>Gagal menutup posisi:</b> ${err.message}`, { parse_mode: 'HTML' });
      }
    } else {
      await ctx.answerCallbackQuery();
    }
  });
}
