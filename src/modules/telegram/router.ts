import { Bot } from 'grammy';
import { UserRepository } from '../../database/repositories/userRepository';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { WalletService } from '../wallet/walletService';
import { ScannerService } from '../scanner/scannerService';
import { SecurityFilterService } from '../security/securityFilterService';
import { AnalyzerService } from '../analyzer/analyzerService';
import { handleStartCommand } from './handlers/startHandler';
import { handleWalletMenu } from './handlers/walletHandler';
import { handleScanCommand } from './handlers/scanHandler';
import { handleAutopilotMenu } from './handlers/autopilotHandler';
import { createMainMenuKeyboard } from './formatters/keyboardBuilder';

export function registerBotRoutes(
  bot: Bot,
  services: {
    userRepo: UserRepository;
    autopilotRepo: AutopilotRepository;
    walletService: WalletService;
    scannerService: ScannerService;
    securityService: SecurityFilterService;
    analyzerService: AnalyzerService;
  }
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

  // Command /scan <CA>
  bot.command('scan', async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply('⚠️ Harap masukkan Contract Address (CA).\nContoh: <code>/scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code>', {
        parse_mode: 'HTML',
      });
      return;
    }
    await handleScanCommand(ctx, text, services.scannerService, services.securityService, services.analyzerService);
  });

  // Callback query handling
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    if (data === 'menu_main') {
      await ctx.editMessageText('🏠 <b>Menu Utama</b>\nPilih salah satu aksi di bawah:', {
        parse_mode: 'HTML',
        reply_markup: createMainMenuKeyboard(),
      });
    } else if (data === 'menu_wallet') {
      await handleWalletMenu(ctx, services.walletService);
    } else if (data === 'menu_autopilot') {
      await handleAutopilotMenu(ctx, services.autopilotRepo);
    }
  });
}
