import { Context, InputFile, InlineKeyboard } from 'grammy';
import { TradeRepository } from '../../../database/repositories/tradeRepository';
import { ScannerService } from '../../scanner/scannerService';
import { PnlCardGenerator, PnlCardData } from '../services/pnlCardGenerator';
import { currencyService } from '../../../utils/currencyService';
import { AccountingEngine } from '../../trader/accountingEngine.js';
import { escapeHtml } from '../formatters/messageFormatter';

export async function handlePnlCard(
  ctx: Context,
  tradeId: string,
  tradeRepo: TradeRepository,
  scannerService: ScannerService
): Promise<void> {
  if (!ctx.from) return;

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: '🎨 Membuat PnL Card...' });
  }

  const trade = await tradeRepo.getTradeById(tradeId);
  if (!trade || trade.user_id !== ctx.from.id) {
    await ctx.reply('⚠️ Data trade tidak ditemukan.');
    return;
  }

  await currencyService.fetchRates();
  let currentPriceUsd = trade.exit_price_usd ?? 0;
  if (!currentPriceUsd && trade.token_mint) {
    const pair = await scannerService.scanTokenByAddress(trade.token_mint);
    currentPriceUsd = pair ? parseFloat(pair.priceUsd || '0') : 0;
  }

  let pnlPercent = trade.pnl_percent ?? 0;
  let pnlSol = trade.pnl_sol ?? 0;

  if (trade.status === 'OPEN' || trade.status === 'PARTIAL_EXIT') {
    if (currentPriceUsd > 0 && trade.entry_price_usd > 0) {
      const liveAcct = AccountingEngine.calculateLiveValuation({
        trade,
        currentPriceUsd,
      });
      pnlPercent = liveAcct.pnlPercent;
      pnlSol = liveAcct.pnlSol;
    }
  }

  const pnlIdr = currencyService.solToIdr(pnlSol);
  const pnlIdrText = pnlIdr !== null ? currencyService.formatIdr(pnlIdr) : undefined;
  const isProfit = pnlPercent >= 0;

  const cardData: PnlCardData = {
    tokenSymbol: trade.token_symbol || 'UNKNOWN',
    tokenMint: trade.token_mint || '',
    isProfit,
    pnlPercent,
    pnlSol,
    pnlIdrText,
    entryPriceUsd: Number(trade.entry_price_usd ?? 0),
    currentPriceUsd: Number(currentPriceUsd ?? trade.entry_price_usd ?? 0),
    solAmount: Number(trade.sol_amount ?? 0),
    isDryRun: Boolean(trade.is_dry_run),
    strategy: trade.strategy || 'AUTOPILOT',
    status: trade.status,
    timestampText: new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB',
  };

  try {
    const imageBuffer = await PnlCardGenerator.generateCardBuffer(cardData);
    const sign = isProfit ? '+' : '';
    const emoji = isProfit ? '🚀' : '🔻';
    const caption = `
${emoji} <b>PnL Card: ${escapeHtml(trade.token_symbol)}</b>
───────────────────────────
• <b>Return:</b> <b>${sign}${pnlPercent.toFixed(2)}%</b>
• <b>Profit/Loss:</b> <code>${sign}${pnlSol.toFixed(4)} SOL</code> ${pnlIdrText ? `(≈ ${sign}${pnlIdrText})` : ''}
• <b>Token Mint:</b> <code>${trade.token_mint}</code>
• <b>Mode:</b> ${trade.is_dry_run ? '🟢 [PAPER]' : '⚡ [LIVE]'}

<i>Bagikan kartu grafis ini ke Telegram atau Twitter (X)!</i>
`.trim();

    const keyboard = new InlineKeyboard()
      .url('📊 Chart DexScreener', `https://dexscreener.com/solana/${trade.token_mint}`)
      .text('🔙 Kembali ke Posisi', `view_pos:${trade.id}`)
      .row()
      .text('🏠 Dashboard', 'menu_main');

    await ctx.replyWithPhoto(new InputFile(imageBuffer, `pnl_${trade.token_symbol}.png`), {
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (err: any) {
    await ctx.reply(`⚠️ Gagal membuat PnL Card: ${escapeHtml(err.message || 'Error tidak diketahui')}`);
  }
}
