import { Context } from 'grammy';
import { ScannerService } from '../../scanner/scannerService';
import { SecurityFilterService } from '../../security/securityFilterService';
import { AnalyzerService } from '../../analyzer/analyzerService';
import { formatTokenReport } from '../formatters/messageFormatter';
import { createTokenKeyboard } from '../formatters/keyboardBuilder';

export async function handleScanCommand(
  ctx: Context,
  tokenMint: string,
  scannerService: ScannerService,
  securityService: SecurityFilterService,
  analyzerService: AnalyzerService
): Promise<void> {
  const isCallback = !!ctx.callbackQuery;
  const callbackMessageId = isCallback && ctx.callbackQuery?.message
    ? ctx.callbackQuery.message.message_id
    : undefined;

  let activeMessageId = callbackMessageId;

  if (isCallback) {
    try {
      await ctx.answerCallbackQuery({ text: '🔄 Memperbarui analisis token...' });
    } catch {
      // ignore
    }
  } else {
    const loadingMsg = await ctx.reply('⏳ <i>Sedang memindai kontrak token dan data on-chain real-time...</i>', {
      parse_mode: 'HTML',
    });
    activeMessageId = loadingMsg.message_id;
  }

  const chatId = ctx.chat?.id;
  if (!chatId || !activeMessageId) return;

  try {
    const pair = await scannerService.scanTokenByAddress(tokenMint);
    if (!pair) {
      await ctx.api.editMessageText(
        chatId,
        activeMessageId,
        `❌ <b>Token Tidak Ditemukan!</b>\nTidak ada pool likuiditas aktif di Solana untuk CA: <code>${tokenMint}</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const priceUsd = parseFloat(pair.priceUsd || '0');
    const security = await securityService.evaluateToken(tokenMint, {
      liquidityUsd: pair.liquidity?.usd || null,
      marketCapUsd: pair.marketCap || pair.fdv || null,
    });

    const candles = await scannerService.getCandles('solana', pair.pairAddress, 'minute', 5);
    const pastVolumes = candles.slice(0, Math.max(0, candles.length - 1)).map(c => c.volume);
    const currentVolume = pair.volume?.m5 || (candles.length > 0 ? candles[candles.length - 1].volume : 0);

    const indicators = analyzerService.calculateIndicators(candles, priceUsd, currentVolume, pastVolumes);
    
    let aiAnalysis = null;
    if (indicators) {
       aiAnalysis = await analyzerService.analyzeWithLlm(pair.baseToken.symbol, priceUsd, indicators, security.riskFlags);
    }

    const reportText = formatTokenReport(pair, security, aiAnalysis, !!indicators);
    const keyboard = createTokenKeyboard(tokenMint, true);

    await ctx.api.editMessageText(chatId, activeMessageId, reportText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (err: any) {
    if (err?.description?.includes('message is not modified')) {
      return;
    }
    try {
      await ctx.api.editMessageText(
        chatId,
        activeMessageId,
        `⚠️ <b>Gagal memindai token:</b> ${err.message || 'Error tidak diketahui'}`,
        { parse_mode: 'HTML' }
      );
    } catch {
      // ignore
    }
  }
}
