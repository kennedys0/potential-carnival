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
  const wallet = await walletService.getOrCreateWallet(ctx.from.id);

  const text = `
💎 <b>Selamat Datang di Solana Scalper Bot!</b>
───────────────────────────
Bot trading otomatis dan manual tercepat di Solana dengan proteksi anti-rug dan analisa AI terintegrasi.

🛡️ <b>Keunggulan Sistem:</b>
• <b>Paper Trading Default:</b> Berlatih dan uji strategi tanpa risiko dana riil.
• <b>Proteksi Anti-Rug:</b> Filter otomatis mint authority, freeze, dan likuiditas palsu.
• <b>AI Scalping Signals:</b> Kalkulasi indikator teknikal (RSI, EMA, Volume) otomatis.
• <b>Eksekusi Cepat:</b> Integrasi Jupiter DEX swap berkecepatan tinggi.

🔑 <b>Wallet Solana Anda:</b>
<code>${wallet.publicKey}</code> <i>(Tap to copy)</i>
───────────────────────────
<i>Tap tombol di bawah untuk membuka terminal trading:</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🏠 Buka Dashboard Utama', 'menu_main')
    .row()
    .text('🔍 Scan Token', 'menu_scan')
    .text('⚙️ Pengaturan', 'menu_settings')
    .row()
    .text('❓ Panduan Bantuan', 'menu_help');

  // Persistent menu using regular Keyboard
  const persistentKeyboard = new Keyboard()
    .text('/dashboard').text('/positions').text('/autopilot').text('/wallet')
    .row()
    .text('/settings').text('/report').text('/livefeed').text('/help')
    .resized();

  await ctx.reply('⚡ Menu pintasan cepat siap digunakan di keyboard bawah:', { reply_markup: persistentKeyboard });
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}
