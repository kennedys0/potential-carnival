import { SecurityScoreResult } from '../../security/scoreCalculator';
import { AiAnalysis } from '../../analyzer/analyzerService';
import { DexScreenerPair } from '../../scanner/dexScreenerClient';

export const UI_DIVIDER = '───────────────────────────';

export function formatProgressBar(current: number, max: number = 100, length: number = 10): string {
  const percentage = Math.min(Math.max(current / max, 0), 1);
  const filledCount = Math.round(percentage * length);
  const emptyCount = length - filledCount;
  return '▰'.repeat(filledCount) + '▱'.repeat(emptyCount) + ` ${Math.round(current)}/${max}`;
}

export function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatUsd(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(2)}`;
}

export function formatPrice(price: number): string {
  if (price < 0.0001) return `$${price.toFixed(8)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

export function formatTokenReport(
  pair: DexScreenerPair,
  security: SecurityScoreResult,
  ai: AiAnalysis | null,
  hasIndicators: boolean,
  isAiLoading: boolean = false
): string {
  const priceNum = parseFloat(pair.priceUsd || '0');
  let levelEmoji = '🔴';
  if (security.level === 'SAFE') levelEmoji = '🟢';
  else if (security.level === 'CAUTION') levelEmoji = '🟡';
  else if (security.level === 'UNVERIFIED') levelEmoji = '⚪';

  const progressBar = formatProgressBar(security.score, 100);

  const flagList = security.riskFlags.length > 0
    ? security.riskFlags.map((f) => `  ⚠️ ${escapeHtml(f)}`).join('\n')
    : '  ✅ Tidak ada bendera risiko terdeteksi';

  let aiSection = '';
  if (!hasIndicators) {
    aiSection = '<i>🤖 Analisa AI: Menunggu data candle terkumpul...</i>';
  } else if (isAiLoading) {
    aiSection = '<i>⏳ 🤖 Analisa AI: Sedang memproses analisis teknikal on-chain...</i>';
  } else if (!ai) {
    aiSection = '<i>🤖 Analisa AI: Gagal memproses AI</i>';
  } else {
    const verdictEmoji = ai.verdict === 'BUY' ? '🟢' : ai.verdict === 'WAIT' ? '🟡' : '🔴';
    const reasonList = ai.key_reasons.length > 0
      ? ai.key_reasons.map((r) => `  • ${escapeHtml(r)}`).join('\n')
      : '  • Tidak ada catatan khusus';

    aiSection = `
🤖 <b>ANALISA AI SCALPING</b>
• <b>Verdict:</b> ${verdictEmoji} <b>${escapeHtml(ai.verdict)}</b> (Keyakinan: <b>${ai.confidence}%</b>)
• <b>Setup:</b> <code>${escapeHtml(ai.setup_type)}</code>
• <b>Stop Loss:</b> <code>${formatPrice(ai.stop_loss_usd)}</code>  |  <b>R:R:</b> <code>${ai.risk_reward_ratio}</code>
• <b>Rasional Teknis:</b>
${reasonList}
`.trim();
  }

  const m5Change = pair.priceChange?.m5 ?? 0;
  const h1Change = pair.priceChange?.h1 ?? 0;
  const m5Sign = m5Change >= 0 ? '+' : '';
  const h1Sign = h1Change >= 0 ? '+' : '';
  const m5Icon = m5Change >= 0 ? '🟢' : '🔴';

  const timeStr = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });

  return `
💎 <b>${escapeHtml(pair.baseToken.name)} (${escapeHtml(pair.baseToken.symbol)})</b>
<code>${escapeHtml(pair.baseToken.address)}</code> <i>(Tap to copy)</i>
🔗 <a href="https://dexscreener.com/solana/${pair.baseToken.address}">Lihat di DexScreener</a>

${UI_DIVIDER}
📊 <b>Metrik Pasar</b>
• <b>Harga:</b> <code>${formatPrice(priceNum)}</code>
• <b>Perubahan:</b> ${m5Icon} <code>${m5Sign}${m5Change}% (5m)</code> | <code>${h1Sign}${h1Change}% (1h)</code>
• <b>Likuiditas:</b> <code>${formatUsd(pair.liquidity?.usd ?? 0)}</code>
• <b>Volume 5m:</b> <code>${formatUsd(pair.volume?.m5 ?? 0)}</code>

${UI_DIVIDER}
🛡️ <b>Skor Keamanan Anti-Rug</b>
• <b>Status:</b> ${levelEmoji} <b>${security.score}/100</b> [${security.level}]
• <b>Rating:</b> <code>${progressBar}</code>
• <b>Pemeriksaan Kontrak:</b>
${flagList}

${UI_DIVIDER}
${aiSection}

${UI_DIVIDER}
🕒 <i>Diperbarui: ${timeStr} WIB</i>
⚠️ <i>DYOR. Bot ini hanya alat bantu analisa, bukan saran finansial.</i>
`.trim();
}
