import { Context, InlineKeyboard } from 'grammy';
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
  const balance = await walletService.getBalance(wallet.publicKey);

  const text = `
⚡ <b>Selamat Datang di Solana Scalping Bot!</b>

Bot scalping & auto-trading Solana dengan filter anti-rug ketat dan analisa AI real-time.

🔑 <b>Wallet Anda:</b>
<code>${wallet.publicKey}</code> <i>(Tap to copy)</i>

💰 <b>Saldo:</b> <code>${balance.sol.toFixed(4)} SOL</code>
🛡️ <b>Mode:</b> 🟢 <b>PAPER TRADING (Simulasi)</b>

Gunakan tombol di bawah untuk navigasi cepat atau ketik /scan &lt;CA&gt; untuk memindai token.
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔍 Scan Token', 'menu_scan')
    .text('💳 Wallet & Deposit', 'menu_wallet')
    .row()
    .text('🤖 Autopilot', 'menu_autopilot')
    .text('📊 Positions', 'menu_positions')
    .row()
    .text('⚙️ Settings', 'menu_settings')
    .text('❓ Bantuan', 'menu_help');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}
