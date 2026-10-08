import { Context, InlineKeyboard, Keyboard } from 'grammy';
import { UserRepository } from '../../../database/repositories/userRepository';
import { WalletService } from '../../wallet/walletService';

export async function handleStartCommand(
  ctx: Context,
  userRepo: UserRepository,
  walletService: WalletService
): Promise<void> {
  if (!ctx.from) return;

  await userRepo.getOrCreateUser(ctx.from.id, ctx.from.username);
  await walletService.getOrCreateWallet(ctx.from.id);

  const text = `
⚡ <b>Selamat Datang di Solana Scalping Bot!</b>

Bot auto-trading pintar dengan proteksi anti-rug dan analisa AI.
Untuk memulai, silakan buka <b>Dashboard</b>.
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🏠 Buka Dashboard', 'menu_main')
    .row()
    .text('❓ Bantuan', 'menu_help');

  // Persistent menu using regular Keyboard
  const persistentKeyboard = new Keyboard()
    .text('/dashboard').text('/autopilot').text('/positions').text('/livefeed')
    .row()
    .text('/wallet').text('/settings').text('/report').text('/help')
    .resized();

  await ctx.reply('Menu cepat tersedia di bawah:', { reply_markup: persistentKeyboard });
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}
