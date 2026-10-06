import { Context, InlineKeyboard, InputFile } from 'grammy';
import { WalletService } from '../../wallet/walletService';

export async function handleWalletMenu(ctx: Context, walletService: WalletService): Promise<void> {
  if (!ctx.from) return;

  const wallet = await walletService.getOrCreateWallet(ctx.from.id);
  const balance = await walletService.getBalance(wallet.publicKey);
  const qrBuffer = await walletService.generateQrBuffer(wallet.publicKey);

  const text = `
💳 <b>Manajemen Wallet Solana</b>

🔑 <b>Alamat Deposit:</b>
<code>${wallet.publicKey}</code> <i>(Tap to copy)</i>

💰 <b>Saldo Saat Ini:</b>
• <b>SOL:</b> <code>${balance.sol.toFixed(4)} SOL</code> (${balance.lamports.toLocaleString()} lamports)

<i>Deposit terdeteksi otomatis via WebSocket RPC.</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh Saldo', 'wallet_refresh')
    .text('💸 Withdraw', 'wallet_withdraw')
    .row()
    .text('🔑 Export Private Key', 'wallet_export')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  await ctx.replyWithPhoto(new InputFile(qrBuffer, 'wallet-qr.png'), {
    caption: text,
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}
