import { Context } from 'grammy';
import { ScannerService } from '../../scanner/scannerService';
import { SecurityFilterService } from '../../security/securityFilterService';
import { AnalyzerService } from '../../analyzer/analyzerService';
import { escapeHtml, formatTokenReport } from '../formatters/messageFormatter';
import { createTokenKeyboard } from '../formatters/keyboardBuilder';
import { AutopilotRepository } from '../../../database/repositories/autopilotRepository';
import { logger } from '../../../utils/logger';

export async function handleScanCommand(
  ctx: Context,
  tokenMint: string,
  scannerService: ScannerService,
  securityService: SecurityFilterService,
  analyzerService: AnalyzerService,
  autopilotRepo: AutopilotRepository
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
        `❌ <b>Token Tidak Ditemukan!</b>\nTidak ada pool likuiditas aktif di Solana untuk CA: <code>${escapeHtml(tokenMint)}</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const priceUsd = parseFloat(pair.priceUsd || '0');

    // Fetch data concurrently to speed up scan
    let [security, rawCandles, macroCandles, config] = await Promise.all([
      securityService.evaluateToken(tokenMint, {
        liquidityUsd: pair.liquidity?.usd || null,
        marketCapUsd: pair.marketCap || pair.fdv || null,
      }),
      scannerService.getCandles('solana', pair.pairAddress, 'minute', 5),
      scannerService.getCandles('solana', pair.pairAddress, 'minute', 15),
      autopilotRepo.getOrCreateConfig(ctx.from!.id)
    ]);
    
    const candles = rawCandles as any[];

    const pastVolumes = candles.slice(0, Math.max(0, candles.length - 1)).map(c => c.volume);
    const currentVolume = pair.volume?.m5 || (candles.length > 0 ? candles[candles.length - 1].volume : 0);

    const indicators = analyzerService.calculateIndicators(candles, priceUsd, currentVolume, pastVolumes, macroCandles);
    
    // let aiAnalysis = null;
    // We defer AI analysis to the background to speed up UI

    const isDryRun = config.mode === 'PAPER';

    // FIRST RENDER: Show data instantly while AI processes in the background
    const initialReportText = formatTokenReport(pair, security, null, !!indicators, !!indicators);
    const keyboard = createTokenKeyboard(tokenMint, isDryRun);

    await ctx.api.editMessageText(chatId, activeMessageId, initialReportText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    // BACKGROUND PROCESSING: AI Analysis
    if (indicators) {
      analyzerService.analyzeWithLlm(pair.baseToken.symbol, priceUsd, indicators, security.riskFlags)
        .then(async (aiAnalysis) => {
          const finalReportText = formatTokenReport(pair, security, aiAnalysis, true, false);
          await ctx.api.editMessageText(chatId, activeMessageId!, finalReportText, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        })
        .catch((error) => logger.error({ err: error, tokenMint }, 'Background token analysis failed'));
    }
  } catch (err: any) {
    if (err?.description?.includes('message is not modified')) {
      return;
    }
    try {
      await ctx.api.editMessageText(
        chatId,
        activeMessageId,
        `⚠️ <b>Gagal memindai token:</b> ${escapeHtml(err.message || 'Error tidak diketahui')}`,
        { parse_mode: 'HTML' }
      );
    } catch {
      // ignore
    }
  }
}
