import { Context, InlineKeyboard } from 'grammy';
import { TradeRepository } from '../../../database/repositories/tradeRepository';

import { currencyService } from '../../../utils/currencyService';
import { ScannerService } from '../../scanner/scannerService';
import { AccountingEngine } from '../../trader/accountingEngine.js';
import { escapeHtml } from '../formatters/messageFormatter';
import { WalletService } from '../../wallet/walletService';

export async function handlePositionsMenu(
  ctx: Context,
  tradeRepo: TradeRepository,
  scannerService: ScannerService,
  walletService?: WalletService
): Promise<void> {
  if (!ctx.from) return;

  const openTrades = await tradeRepo.getTradesByStatuses(ctx.from.id, [
    'RESERVED',
    'SIGNED',
    'BROADCAST_ATTEMPTED',
    'PENDING',
    'OPEN',
    'PARTIAL_EXIT',
  ]);
  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';

  // Check claimable rent from empty accounts
  let claimableRentText = '';
  let claimableSol = 0;
  let emptyAccountsCount = 0;
  const activeMints = new Set(openTrades.map((t) => t.token_mint));
  if (walletService) {
    try {
      const claimable = await walletService.getClaimableRent(ctx.from.id, activeMints);
      if (claimable.emptyAccountsCount > 0) {
        emptyAccountsCount = claimable.emptyAccountsCount;
        claimableSol = claimable.claimableSol;
        const rentIdr = currencyService.solToIdr(claimable.claimableSol);
        const rentIdrText = rentIdr !== null ? ` (≈ ${currencyService.formatIdr(rentIdr)})` : '';
        claimableRentText = `🏷️ <b>Rent Fee Siap Diklaim:</b>\n└ <code>${claimable.emptyAccountsCount} Akun Kosong</code> (≈ <code>+${claimable.claimableSol.toFixed(4)} SOL</code>${rentIdrText})\n\n`;
      }
    } catch {
      // ignore
    }
  }

  const keyboard = new InlineKeyboard();
  let text = '';

  if (openTrades.length === 0) {
    let emptyRentSection = '';
    if (claimableRentText) {
      emptyRentSection = `${claimableRentText}💡 <i>Anda memiliki token account dari trade sebelumnya yang sudah ditutup. Klaim sekarang untuk mengembalikan SOL sewa akun ke wallet Anda!</i>\n\n`;
    }

    text = `
📊 <b>Portofolio Kosong</b>
───────────────────────────
<i>Tidak ada posisi trading yang sedang aktif.</i>

${emptyRentSection}💡 <b>Cara Memulai Trading:</b>
1. Ketik <code>/scan &lt;CA&gt;</code> untuk menganalisis token on-chain.
2. Gunakan tombol Buy untuk eksekusi manual cepat.
3. Aktifkan <b>🤖 Autopilot</b> untuk auto-trading otomatis.

• <i>Diperbarui: ${timestamp}</i>
`.trim();

    if (emptyAccountsCount > 0) {
      keyboard.text(`🏷️ Klaim Rent Fee (+${claimableSol.toFixed(3)} SOL)`, 'claim_rent').row();
    }
    keyboard
      .text('🔍 Scan Token Baru', 'menu_scan')
      .text('🤖 Nyalakan Autopilot', 'menu_autopilot')
      .row()
      .text('🔄 Refresh', 'menu_positions')
      .text('🏠 Dashboard', 'menu_main');
  } else {
    text = `📊 <b>Portofolio Aktif (${openTrades.length})</b>\n───────────────────────────\n\n`;
    await currencyService.fetchRates();

    const pricePromises = openTrades.map(t => t.token_mint ? scannerService.scanTokenByAddress(t.token_mint) : Promise.resolve(null));
    const pairs = await Promise.all(pricePromises);

    let totalPnlUsd = 0;
    let totalPnlSol = 0;

    for (let i = 0; i < openTrades.length; i++) {
      const trade = openTrades[i];
      const pair = pairs[i];
      const currentPriceUsd = pair ? parseFloat(pair.priceUsd || '0') : 0;
      
      const mode = trade.is_dry_run ? '🟢' : '⚡';
      let pnlPercent = 0;
      let pnlSol = 0;
      let pnlIcon = '➖';
      
      const isPending = !['OPEN', 'PARTIAL_EXIT'].includes(trade.status);

      if (!isPending && currentPriceUsd > 0 && trade.entry_price_usd > 0) {
        const liveAcct = AccountingEngine.calculateLiveValuation({
          trade,
          currentPriceUsd
        });
        pnlPercent = liveAcct.pnlPercent;
        pnlSol = liveAcct.pnlSol;
        pnlIcon = pnlPercent > 0 ? '🟢' : pnlPercent < 0 ? '🔴' : '➖';
        totalPnlUsd += (currencyService.solToUsd(liveAcct.pnlSol) ?? 0);
        totalPnlSol += liveAcct.pnlSol;
      }
      
      const pnlIdr = currencyService.solToIdr(pnlSol);
      const pnlIdrFormatted = pnlIdr !== null ? currencyService.formatIdr(pnlIdr) : 'N/A';

      const tokenMint = trade.token_mint || '';
      const dexUrl = tokenMint ? `https://dexscreener.com/solana/${tokenMint}` : 'https://dexscreener.com/solana';

      if (isPending) {
        text += `${i + 1}. ${mode} <a href="${dexUrl}"><b>${escapeHtml(trade.token_symbol)}</b></a> | ⏳ <b>${trade.status}</b>\n`;
        text += `   ├ Status: <code>Membeli...</code> | Harap tunggu konfirmasi\n`;
        text += `   ├ Modal: <code>${trade.sol_amount} SOL</code>\n`;
        text += `   └ CA: <code>${tokenMint}</code>\n\n`;
        keyboard.text(`⏳ ${trade.token_symbol}`, `view_pos:${trade.id}`);
      } else {
        text += `${i + 1}. ${mode} <a href="${dexUrl}"><b>${escapeHtml(trade.token_symbol)}</b></a> | ${pnlIcon} <b>${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b>\n`;
        text += `   ├ Ukuran: <code>${trade.sol_amount} SOL</code>\n`;
        text += `   ├ PnL: ${pnlSol >= 0 ? '+' : ''}${pnlIdrFormatted}\n`;
        text += `   └ CA: <code>${tokenMint}</code>\n\n`;

        const btnPnlTag = `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%`;
        keyboard.text(`${pnlIcon} ${trade.token_symbol} (${btnPnlTag})`, `view_pos:${trade.id}`);
      }
      
      if ((i + 1) % 2 === 0) keyboard.row();
    }
    
    if (openTrades.length % 2 !== 0) keyboard.row();

    const totalPnlIdr = currencyService.solToIdr(totalPnlSol);
    const totalPnlIdrText = totalPnlIdr !== null ? currencyService.formatIdr(totalPnlIdr) : 'N/A';
    text += `───────────────────────────\n`;
    text += `💰 <b>Total Unre. PnL:</b> ${totalPnlSol >= 0 ? '+' : ''}${totalPnlSol.toFixed(4)} SOL (≈ ${totalPnlSol >= 0 ? '+' : ''}${totalPnlIdrText})\n`;
    if (claimableRentText) {
      text += `\n${claimableRentText}`;
    }
    text += `• <i>Diperbarui: ${timestamp}</i>`;

    keyboard.row();
    if (emptyAccountsCount > 0) {
      keyboard.text(`🏷️ Klaim Rent Fee (+${claimableSol.toFixed(3)} SOL)`, 'claim_rent').row();
    }
    keyboard
      .text('🔍 Scan Token', 'menu_scan')
      .text('🔄 Refresh', 'menu_positions')
      .row()
      .text('🏠 Dashboard Utama', 'menu_main');
  }

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handlePositionDetail(
  ctx: Context,
  tradeId: string,
  tradeRepo: TradeRepository,
  scannerService: ScannerService
): Promise<void> {
  if (!ctx.from) return;

  const trade = await tradeRepo.getTradeById(tradeId);
  if (!trade || trade.user_id !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: '⚠️ Posisi tidak ditemukan atau sudah ditutup.' });
    return;
  }

  await currencyService.fetchRates();
  const pair = await scannerService.scanTokenByAddress(trade.token_mint);
  const currentPriceUsd = pair ? parseFloat(pair.priceUsd || '0') : 0;
  
  const modeBadge = trade.is_dry_run ? '🟢 [PAPER]' : '⚡ [LIVE]';
  
  let pnlPercent = 0;
  let pnlSol = 0;
  let pnlUsd = 0;
  let pnlIdr: number | null = 0;
  
  const isPending = !['OPEN', 'PARTIAL_EXIT'].includes(trade.status);
  
  if (!isPending && currentPriceUsd > 0 && trade.entry_price_usd > 0) {
    const liveAcct = AccountingEngine.calculateLiveValuation({
      trade,
      currentPriceUsd
    });
    pnlPercent = liveAcct.pnlPercent;
    pnlSol = liveAcct.pnlSol;
    pnlUsd = currencyService.solToUsd(liveAcct.pnlSol) ?? 0;
    pnlIdr = currencyService.solToIdr(liveAcct.pnlSol);
  }

  const pnlIcon = pnlPercent > 0 ? '🟢' : pnlPercent < 0 ? '🔴' : '➖';
  const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';

  const dexUrl = `https://dexscreener.com/solana/${trade.token_mint}`;

  const text = isPending ? `
📈 <b>Detail Posisi: <a href="${dexUrl}">${escapeHtml(trade.token_symbol)}</a></b>
───────────────────────────
• <b>Mode:</b> ${modeBadge}
• <b>Status:</b> ⏳ <code>${trade.status}</code>
• <b>Alokasi:</b> <code>${trade.sol_amount} SOL</code>

🔗 <b>Contract Address:</b>
<code>${trade.token_mint}</code>
<a href="${dexUrl}">📊 Lihat di DexScreener</a>

<i>Order Anda sedang diproses dan menunggu konfirmasi jaringan Solana. Silakan refresh dalam beberapa detik.</i>
───────────────────────────
🕒 <i>Diperbarui: ${timestamp}</i>
`.trim() : `
📈 <b>Detail Posisi: <a href="${dexUrl}">${escapeHtml(trade.token_symbol)}</a></b>
───────────────────────────
• <b>Mode:</b> ${modeBadge}
• <b>Status:</b> <code>${trade.status}</code>
• <b>Ukuran:</b> <code>${trade.sol_amount} SOL</code> (${trade.token_amount.toFixed(2)} tokens)

<b>Performa Harga:</b>
• <b>Entry:</b> <code>$${trade.entry_price_usd.toFixed(6)}</code>
• <b>Sekarang:</b> <code>$${currentPriceUsd.toFixed(6)}</code>
• <b>PnL:</b> ${pnlIcon} <b>${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b>
• <b>Value:</b> <code>${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL</code> (≈ ${pnlIdr !== null && pnlIdr >= 0 ? '+' : ''}${currencyService.formatIdr(pnlIdr)})

🔗 <b>Contract Address:</b>
<code>${trade.token_mint}</code>
<a href="${dexUrl}">📊 Lihat di DexScreener</a>
───────────────────────────
🕒 <i>Diperbarui: ${timestamp}</i>
`.trim();

  const keyboard = new InlineKeyboard();
  if (!isPending) {
    keyboard
      .text('🔴 Jual Semua (100%)', `sell:${trade.id}:100`)
      .text('🟠 Jual Sebagian (50%)', `sell:${trade.id}:50`)
      .row()
      .text('📸 Share PnL Card', `pnl_card:${trade.id}`)
      .url('📊 Chart DexScreener', `https://dexscreener.com/solana/${trade.token_mint}`)
      .row();
  } else {
    keyboard
      .url('📊 Chart DexScreener', `https://dexscreener.com/solana/${trade.token_mint}`)
      .text('🔄 Refresh', `view_pos:${trade.id}`)
      .row();
  }
  keyboard
    .text('🔄 Refresh', `view_pos:${trade.id}`)
    .text('🔙 Portofolio', 'menu_positions')
    .row()
    .text('🏠 Dashboard', 'menu_main');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
