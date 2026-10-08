import { Context, InlineKeyboard, InputFile } from 'grammy';
import { WalletService } from '../../wallet/walletService';

import { currencyService } from '../../../utils/currencyService';
import { getRedisConnection } from '../../../queue/connection';
import { v4 as uuidv4 } from 'uuid';

export async function handleWalletMenu(ctx: Context, walletService: WalletService): Promise<void> {
  if (!ctx.from) return;

  await currencyService.fetchRates();
  const wallet = await walletService.getOrCreateWallet(ctx.from.id);
  const balance = await walletService.getBalance(wallet.publicKey);

  const solValueIdr = currencyService.solToIdr(balance.sol);
  const solValueUsd = currencyService.solToUsd(balance.sol);

  const text = `
💳 <b>Manajemen Wallet Solana</b>

🔑 <b>Alamat Deposit:</b>
<code>${wallet.publicKey}</code> <i>(Tap to copy)</i>

💰 <b>Saldo Saat Ini:</b>
• <b>SOL:</b> <code>${balance.sol.toFixed(4)} SOL</code>
• <b>IDR:</b> <code>${currencyService.formatIdr(solValueIdr)}</code> (≈ ${currencyService.formatUsd(solValueUsd)})
• <i>Diperiksa: ${new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</i>

<i>Deposit terdeteksi otomatis via WebSocket RPC.</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh Saldo', 'wallet_refresh')
    .text('💸 Withdraw', 'wallet_withdraw')
    .row()
    .text('🔑 Export Private Key', 'wallet_export')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  if (ctx.callbackQuery) {
    const isPhotoMessage = ctx.callbackQuery.message && 'caption' in ctx.callbackQuery.message;
    try {
      if (isPhotoMessage) {
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
      return;
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
    }
  }

  const qrBuffer = await walletService.generateQrBuffer(wallet.publicKey);
  await ctx.replyWithPhoto(new InputFile(qrBuffer, 'wallet-qr.png'), {
    caption: text,
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

export async function handleWalletRefresh(ctx: Context, walletService: WalletService): Promise<void> {
  if (!ctx.from) return;

  await currencyService.fetchRates();
  const wallet = await walletService.getOrCreateWallet(ctx.from.id);
  const balance = await walletService.getBalance(wallet.publicKey);

  const solValueIdr = currencyService.solToIdr(balance.sol);
  const solValueUsd = currencyService.solToUsd(balance.sol);

  const text = `
💳 <b>Manajemen Wallet Solana</b>

🔑 <b>Alamat Deposit:</b>
<code>${wallet.publicKey}</code> <i>(Tap to copy)</i>

💰 <b>Saldo Saat Ini (Terbaru):</b>
• <b>SOL:</b> <code>${balance.sol.toFixed(4)} SOL</code>
• <b>IDR:</b> <code>${currencyService.formatIdr(solValueIdr)}</code> (≈ ${currencyService.formatUsd(solValueUsd)})
• <i>Diperbarui pada: ${new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh Saldo', 'wallet_refresh')
    .text('💸 Withdraw', 'wallet_withdraw')
    .row()
    .text('🔑 Export Private Key', 'wallet_export')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  const isPhotoMessage = ctx.callbackQuery?.message && 'caption' in ctx.callbackQuery.message;

  try {
    if (isPhotoMessage) {
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
    if (err?.description?.includes('message is not modified')) {
      return;
    }
  }
}

export async function handleWalletWithdrawPrompt(ctx: Context, walletService: WalletService): Promise<void> {
  if (!ctx.from) return;

  const wallet = await walletService.getWalletRecord(ctx.from.id);

  let text = '';
  if (!wallet || !wallet.owner_pubkey) {
    text = `
💸 <b>Withdraw Saldo SOL</b>

⚠️ <b>Alamat Penarikan Belum Diatur!</b>
Demi keamanan, Anda harus mendaftarkan alamat wallet penerima Anda terlebih dahulu menggunakan perintah:

<code>/set_withdraw_address &lt;ALAMAT_SOLANA_ANDA&gt;</code>

<i>Contoh:</i>
<code>/set_withdraw_address 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU</code>
`.trim();
  } else {
    text = `
💸 <b>Withdraw Saldo SOL</b>

Alamat Penarikan Anda:
<code>${wallet.owner_pubkey}</code>

Untuk mencairkan dana ke alamat di atas, gunakan perintah:
<code>/withdraw &lt;JUMLAH_SOL&gt;</code>

<b>Contoh:</b>
<code>/withdraw 0.25</code>
atau
<code>/withdraw MAX</code>

<i>Catatan: Sisakan minimal 0.005 SOL untuk biaya gas jaringan.</i>
`.trim();
  }

  const keyboard = new InlineKeyboard()
    .text('💳 Cek Saldo', 'menu_wallet')
    .text('🏠 Menu Utama', 'menu_main');

  if (ctx.callbackQuery) {
    const isPhoto = ctx.callbackQuery.message && 'caption' in ctx.callbackQuery.message;
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
      return;
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
    }
  }

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

export async function handleWalletExportPrompt(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const text = `
⚠️ <b>PERINGATAN KEAMANAN TINGGI!</b> ⚠️

Private Key memberikan akses penuh dan tak terbatas ke seluruh aset di wallet Anda.
<b>JANGAN PERNAH</b> membagikan Private Key ini kepada siapa pun! 
Jika Anda mengerti risiko ini dan tetap ingin mengekspor Private Key Anda, balas pesan ini dengan mengetik perintah berikut dengan persis:

<code>/export_key SAYA_MENGERTI_RISIKONYA</code>

<i>Pesan berisi private key akan diproteksi agar tidak bisa di-forward, dan akan terhapus otomatis dalam 1 menit.</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('❌ Batal', 'menu_wallet');

  if (ctx.callbackQuery) {
    const isPhoto = ctx.callbackQuery.message && 'caption' in ctx.callbackQuery.message;
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
      return;
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
    }
  }

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

export async function handleWalletExportExecute(
  ctx: Context,
  walletService: WalletService,
  redis: any
): Promise<void> {
  if (!ctx.from || !ctx.chat) return;

  // Pastikan hanya di private chat
  if (ctx.chat.type !== 'private') {
    await ctx.reply('⚠️ Export private key hanya bisa dilakukan di Private Chat (DM) dengan bot.');
    return;
  }

  try {
    const privateKey = await walletService.exportPrivateKey(ctx.from.id);

    const text = `
🔑 <b>Base58 Private Key Anda:</b>
<code>${privateKey}</code>

<i>Klik teks di atas untuk menyalin. Pesan ini akan otomatis terhapus dalam 1 menit!</i>
`.trim();

    const msg = await ctx.reply(text, { 
      parse_mode: 'HTML', 
      protect_content: true // tidak bisa di-forward / screenshot (jika didukung)
    });

    const chatId = ctx.chat.id;
    const messageId = msg.message_id;

    // Schedule deletion via Redis to survive restarts
    const jobId = `delete_msg:${chatId}:${messageId}`;
    await redis.set(jobId, JSON.stringify({ chatId, messageId }), 'EX', 60);
    
    // Also try doing it in-memory immediately just in case
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(chatId, messageId);
        await redis.del(jobId);
      } catch {
        // ignore
      }
    }, 60000);

  } catch (err: any) {
    await ctx.reply(`⚠️ Gagal mengekspor Private Key: ${err.message}`, { parse_mode: 'HTML' });
  }
}

export async function handleWalletWithdrawConfirm(
  ctx: Context,
  address: string,
  amount: number | 'MAX',
  walletService: WalletService
): Promise<void> {
  if (!ctx.from) return;

  const text = `
🔒 <b>Konfirmasi Withdrawal SOL</b>

<b>Alamat Tujuan:</b>
<code>${address}</code>

<b>Jumlah:</b> <code>${amount === 'MAX' ? 'MAX (Semua Saldo)' : amount + ' SOL'}</code>

<i>Pastikan alamat tujuan valid di jaringan Solana. Transaksi yang sudah terkirim tidak dapat dibatalkan.</i>
`.trim();

  const idempotencyKey = `wd_auth_${ctx.from.id}_${Date.now()}`;
  const amountSol = amount === 'MAX' ? -1 : amount;
  
  const withdrawalId = await walletService['walletRepo'].createWithdrawalAttempt({
    user_id: ctx.from.id,
    amount_sol: amountSol,
    destination_address: address,
    status: 'AUTHORIZED',
    idempotency_key: idempotencyKey
  });

  const keyboard = new InlineKeyboard()
    .text('✅ Confirm Kirim', `wd_exec:${withdrawalId}`)
    .text('❌ Cancel', 'withdraw_cancel');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

export async function handleWalletWithdrawExecute(
  ctx: Context,
  withdrawalId: string,
  walletService: WalletService
): Promise<void> {
  if (!ctx.from) return;
  
  let claimedRecord;
  try {
    const claimResult = await walletService['walletRepo'].atomicClaimWithdrawal(withdrawalId, ctx.from.id);
    claimedRecord = claimResult.v_attempt;
    const claimStatus = claimResult.status;
    
    if (claimStatus !== 'SUCCESS' || !claimedRecord) {
      throw new Error(`Sesi penarikan tidak valid, sudah diproses, atau dibatalkan. Status: ${claimStatus}`);
    }

    const amount = Number(claimedRecord.amount_sol) === -1 ? 'MAX' : Number(claimedRecord.amount_sol);
    const address = claimedRecord.destination_address;
    
    // Attempt withdrawal
    const signature = await walletService.withdrawSol(ctx.from.id, address, amount, withdrawalId);
    
    const text = `
✅ <b>Withdrawal Berhasil Terkirim!</b>

<b>Alamat Tujuan:</b> <code>${address}</code>
<b>Jumlah:</b> <code>${amount === 'MAX' ? 'Seluruh Saldo' : amount + ' SOL'}</code>

🔍 <b>Lihat di Explorer:</b>
<a href="https://solscan.io/tx/${signature}">Solscan</a>
    `.trim();

    const keyboard = new InlineKeyboard()
      .text('💳 Kembali ke Wallet', 'menu_wallet')
      .row()
      .text('🏠 Menu Utama', 'menu_main');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } });
  } catch (err: any) {
    const text = `❌ <b>Gagal Withdrawal:</b> ${err.message}`;
    const keyboard = new InlineKeyboard()
      .text('💳 Kembali ke Wallet', 'menu_wallet')
      .row()
      .text('🏠 Menu Utama', 'menu_main');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

