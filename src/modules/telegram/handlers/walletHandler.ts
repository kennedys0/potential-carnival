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

export async function handleWalletRefresh(ctx: Context, walletService: WalletService): Promise<void> {
  if (!ctx.from) return;

  const wallet = await walletService.getOrCreateWallet(ctx.from.id);
  const balance = await walletService.getBalance(wallet.publicKey);

  const text = `
💳 <b>Manajemen Wallet Solana</b>

🔑 <b>Alamat Deposit:</b>
<code>${wallet.publicKey}</code> <i>(Tap to copy)</i>

💰 <b>Saldo Saat Ini (Terbaru):</b>
• <b>SOL:</b> <code>${balance.sol.toFixed(4)} SOL</code> (${balance.lamports.toLocaleString()} lamports)
• <i>Diperbarui pada: ${new Date().toLocaleTimeString()} UTC</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh Saldo', 'wallet_refresh')
    .text('💸 Withdraw', 'wallet_withdraw')
    .row()
    .text('🔑 Export Private Key', 'wallet_export')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  try {
    await ctx.editMessageCaption({
      caption: text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handleWalletWithdrawPrompt(ctx: Context): Promise<void> {
  const text = `
💸 <b>Withdraw Saldo SOL</b>

Untuk melakukan penarikan saldo ke wallet eksternal Anda, silakan ketik perintah dengan format berikut:
<code>/withdraw &lt;ALAMAT_SOLANA&gt; &lt;JUMLAH_SOL&gt;</code>

<b>Contoh:</b>
<code>/withdraw 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU 0.25</code>

<i>Catatan: Sisakan minimal 0.005 SOL untuk biaya gas jaringan.</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('💳 Cek Saldo', 'menu_wallet')
    .text('🏠 Menu Utama', 'menu_main');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

export async function handleWalletExportPrompt(ctx: Context, walletService: WalletService): Promise<void> {
  if (!ctx.from) return;

  try {
    const privateKey = await walletService.exportPrivateKey(ctx.from.id);

    const text = `
⚠️ <b>PERINGATAN KEAMANAN TINGGI!</b> ⚠️

Private Key memberikan akses penuh dan tak terbatas ke seluruh aset di wallet Anda.
<b>JANGAN PERNAH</b> membagikan Private Key ini kepada siapa pun!

🔑 <b>Base58 Private Key Anda:</b>
<code>${privateKey}</code>

<i>Klik teks di atas untuk menyalin. Segera simpan di password manager aman dan hapus pesan ini setelah selesai!</i>
`.trim();

    const keyboard = new InlineKeyboard()
      .text('💳 Kembali ke Wallet', 'menu_wallet')
      .text('🏠 Menu Utama', 'menu_main');

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err: any) {
    await ctx.reply(`⚠️ Gagal mengekspor Private Key: ${err.message}`, { parse_mode: 'HTML' });
  }
}
