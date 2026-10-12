import { Context, InlineKeyboard } from 'grammy';
import { WalletService } from '../../wallet/walletService';
import { TradeRepository } from '../../../database/repositories/tradeRepository';
import { currencyService } from '../../../utils/currencyService';
import { escapeHtml } from '../formatters/messageFormatter';
import { getRedisConnection } from '../../../queue/connection';

export async function handleClaimRent(
  ctx: Context,
  walletService: WalletService,
  tradeRepo: TradeRepository
): Promise<void> {
  if (!ctx.from) return;
  const userId = ctx.from.id;
  const redis = getRedisConnection();
  const lockKey = `claim_rent_lock:${userId}`;

  // Prevent concurrent requests
  const isLocked = await redis.get(lockKey);
  if (isLocked) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: '⏳ Klaim rent fee sedang diproses...', show_alert: true });
    } else {
      await ctx.reply('⏳ Klaim rent fee sedang diproses, harap tunggu sebentar.');
    }
    return;
  }

  await redis.set(lockKey, '1', 'EX', 60);

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: '🔄 Memeriksa akun token kosong...' });
  }

  try {
    const activeTrades = await tradeRepo.getTradesByStatuses(userId, [
      'RESERVED',
      'SIGNED',
      'BROADCAST_ATTEMPTED',
      'PENDING',
      'OPEN',
      'PARTIAL_EXIT',
    ]);
    const activeMints = new Set(activeTrades.map((t) => t.token_mint));

    const claimable = await walletService.getClaimableRent(userId, activeMints);

    if (claimable.emptyAccountsCount === 0) {
      await redis.del(lockKey);
      const text = `
ℹ️ <b>Tidak Ada Rent Fee Yang Dapat Diklaim</b>
───────────────────────────
Semua token account di wallet Anda saat ini aktif atau sudah ditutup. Tidak ada sisa saldo sewa akun (rent fee) yang dapat dikembalikan.

💡 <i>Setiap kali Anda menjual 100% dari suatu posisi token, akun token kosong tersebut dapat diklaim kembali di sini untuk mendapatkan refund ~0.002 SOL per token.</i>
`.trim();

      const keyboard = new InlineKeyboard()
        .text('📊 Cek Portofolio', 'menu_positions')
        .text('📈 Laporan Harian', 'menu_report')
        .row()
        .text('🏠 Dashboard Utama', 'menu_main');

      if (ctx.callbackQuery) {
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch {
          await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
      return;
    }

    // Inform user that claim is executing
    const progressText = `
⏳ <b>Mengembalikan Rent Fee...</b>
───────────────────────────
Sedang menutup <b>${claimable.emptyAccountsCount} akun token kosong</b>...
Estimasi pengembalian: <code>~${claimable.claimableSol.toFixed(4)} SOL</code>

<i>Mohon tunggu konfirmasi di blockchain Solana...</i>
`.trim();

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(progressText, { parse_mode: 'HTML' });
      } catch {
        // ignore
      }
    } else {
      await ctx.reply(progressText, { parse_mode: 'HTML' });
    }

    const result = await walletService.claimRent(userId, activeMints);
    await redis.del(lockKey);

    await currencyService.fetchRates();
    const idr = currencyService.solToIdr(result.reclaimedSol);
    const idrText = idr !== null ? ` (≈ ${currencyService.formatIdr(idr)})` : '';

    if (result.success) {
      const txLinks = result.signatures
        .map((sig, i) => `├ <a href="https://solscan.io/tx/${sig}">Solscan Tx #${i + 1}</a>`)
        .join('\n');

      const text = `
✅ <b>Klaim Rent Fee Berhasil!</b>
───────────────────────────
• <b>Akun Ditutup:</b> <code>${result.accountsClosed} Token Account</code>
• <b>SOL Dikembalikan:</b> <code>+${result.reclaimedSol.toFixed(4)} SOL</code>${idrText}

🔗 <b>Transaksi On-Chain:</b>
${txLinks}

💰 <i>Saldo SOL telah langsung dikembalikan ke wallet trading Anda!</i>
`.trim();

      const keyboard = new InlineKeyboard()
        .text('📊 Cek Portofolio', 'menu_positions')
        .text('📈 Laporan Harian', 'menu_report')
        .row()
        .text('🏠 Dashboard Utama', 'menu_main');

      if (ctx.callbackQuery) {
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch {
          await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } else {
      const text = `
⚠️ <b>Gagal Mengklaim Rent Fee</b>
───────────────────────────
${escapeHtml(result.message)}

<i>Silakan pastikan wallet Anda memiliki sedikit SOL untuk biaya gas jaringan (minimal 0.0001 SOL) lalu coba lagi.</i>
`.trim();

      const keyboard = new InlineKeyboard()
        .text('🔄 Coba Lagi', 'claim_rent')
        .text('📊 Portofolio', 'menu_positions')
        .row()
        .text('🏠 Dashboard Utama', 'menu_main');

      if (ctx.callbackQuery) {
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch {
          await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    }
  } catch (error: any) {
    await redis.del(lockKey);
    const errorText = `⚠️ Terjadi kesalahan saat mengklaim rent fee: ${escapeHtml(error.message || 'Error tidak diketahui')}`;
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(errorText, { parse_mode: 'HTML' });
      } catch {
        await ctx.reply(errorText, { parse_mode: 'HTML' });
      }
    } else {
      await ctx.reply(errorText, { parse_mode: 'HTML' });
    }
  }
}
