import { Bot, InlineKeyboard } from 'grammy';
import { UserRepository } from '../../database/repositories/userRepository';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { TradeRepository } from '../../database/repositories/tradeRepository';
import { WalletService } from '../wallet/walletService';
import { ScannerService } from '../scanner/scannerService';
import { SecurityFilterService } from '../security/securityFilterService';
import { AnalyzerService } from '../analyzer/analyzerService';
import { TraderService } from '../trader/traderService';
import { handleStartCommand } from './handlers/startHandler';
import {
  handleWalletMenu,
  handleWalletRefresh,
  handleWalletWithdrawPrompt,
  handleWalletExportPrompt,
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
    await handlePositionsMenu(ctx, services.tradeRepo);
  });

  // Command /help
  bot.command('help', async (ctx) => {
    await handleHelpMenu(ctx);
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

  // Command /withdraw
  bot.command('withdraw', async (ctx) => {
    const match = ctx.match?.trim();
    if (!match) {
      await handleWalletWithdrawPrompt(ctx);
      return;
    }
    await ctx.reply('🔒 <b>Konfirmasi Withdrawal</b>\nFitur transfer broadcast on-chain diproteksi. Pastikan wallet tujuan valid.', {
      parse_mode: 'HTML',
    });
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
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: createMainMenuKeyboard(),
        });
      } catch {
        await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: createMainMenuKeyboard(),
        });
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
      await handlePositionsMenu(ctx, services.tradeRepo);
    } else if (data === 'menu_help') {
      await ctx.answerCallbackQuery();
      await handleHelpMenu(ctx);
    } else if (data === 'menu_scan') {
      await ctx.answerCallbackQuery();
      await ctx.reply(
        '🔍 <b>Scan Token Solana</b>\n\n' +
        'Silakan kirimkan <b>Contract Address (CA)</b> token Solana di chat ini, atau gunakan perintah:\n' +
        '<code>/scan &lt;CA&gt;</code>\n\n' +
        '<i>Contoh: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</i>',
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🏠 Menu Utama', 'menu_main'),
        }
      );
    }

    // 2. Wallet Actions
    else if (data === 'wallet_refresh') {
      await ctx.answerCallbackQuery({ text: '🔄 Memperbarui saldo...' });
      await handleWalletRefresh(ctx, services.walletService);
    } else if (data === 'wallet_withdraw') {
      await ctx.answerCallbackQuery();
      await handleWalletWithdrawPrompt(ctx);
    } else if (data === 'wallet_export') {
      await ctx.answerCallbackQuery();
      await handleWalletExportPrompt(ctx, services.walletService);
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
      await services.autopilotRepo.updateConfig(ctx.from.id, { mode: newMode });
      await ctx.answerCallbackQuery({
        text: `Mode diubah ke: ${newMode === 'PAPER' ? '🟢 PAPER TRADING (Simulasi)' : '⚡ LIVE ON-CHAIN'}`,
      });
      await handleSettingsMenu(ctx, services.autopilotRepo);
    } else if (data.startsWith('settings_size_')) {
      if (!ctx.from) return;
      const size = parseFloat(data.replace('settings_size_', '')) || 0.1;
      await services.autopilotRepo.updateConfig(ctx.from.id, {
        sizing_params: { fixed_sol: size },
      });
      await ctx.answerCallbackQuery({ text: `Trade size diubah ke ${size} SOL` });
      await handleSettingsMenu(ctx, services.autopilotRepo);
    }

    // 5. Token Scan Actions
    else if (data.startsWith('refresh:')) {
      const tokenMint = data.split(':')[1];
      await ctx.answerCallbackQuery({ text: '🔄 Memindai ulang token...' });
      await handleScanCommand(ctx, tokenMint, services.scannerService, services.securityService, services.analyzerService);
    } else if (data.startsWith('buy:')) {
      if (!ctx.from) return;
      const [, mint, amountStr] = data.split(':');
      const amount = parseFloat(amountStr) || 0.1;

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

        await ctx.reply(
          `✅ <b>Order Berhasil Dieksekusi!</b>\n\n` +
          `• <b>Mode:</b> ${isDryRun ? '🟢 PAPER TRADING (Simulasi)' : '⚡ LIVE ON-CHAIN'}\n` +
          `• <b>Token:</b> ${symbol} (<code>${mint.slice(0, 8)}...</code>)\n` +
          `• <b>Alokasi:</b> <code>${amount} SOL</code>\n` +
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
    } else {
      await ctx.answerCallbackQuery();
    }
  });
}
