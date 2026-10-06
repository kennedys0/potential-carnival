import { SecurityScoreResult } from '../../security/scoreCalculator';
import { AiAnalysis } from '../../analyzer/analyzerService';
import { DexScreenerPair } from '../../scanner/dexScreenerClient';

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
    .replace(/>/g, '&gt;');
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
  hasIndicators: boolean
): string {
  const priceNum = parseFloat(pair.priceUsd || '0');
  const levelEmoji = security.level === 'SAFE' ? '🟢' : security.level === 'CAUTION' ? '🟡' : '🔴';
  const progressBar = formatProgressBar(security.score, 100);

  const flagList = security.riskFlags.length > 0
    ? security.riskFlags.map((f) => `• ⚠️ ${escapeHtml(f)}`).join('\n')
    : '• ✅ Tidak ada bendera risiko terdeteksi';

  let aiSection = '';
  if (!hasIndicators) {
    aiSection = '<i>🤖 Analisa AI: Data tidak cukup (menunggu candle lebih banyak)</i>';
  } else if (!ai) {
    aiSection = '<i>🤖 Analisa AI: AI unavailable</i>';
  } else {
    const verdictEmoji = ai.verdict === 'BUY' ? '🟢' : ai.verdict === 'WAIT' ? '🟡' : '🔴';
    aiSection = `
🤖 <b>Analisa AI Scalping:</b>
• <b>Verdict:</b> ${verdictEmoji} <b>${escapeHtml(ai.verdict)}</b> (Confidence: ${ai.confidence}%)
• <b>Setup:</b> ${escapeHtml(ai.setup_type)}
• <b>Stop Loss:</b> ${formatPrice(ai.stop_loss_usd)} | <b>R:R:</b> ${ai.risk_reward_ratio}
• <b>Alasan:</b>
${ai.key_reasons.map((r) => `  - ${escapeHtml(r)}`).join('\n')}
`;
  }

  return `
🚀 <b>${pair.baseToken.name} (${pair.baseToken.symbol})</b>
<code>${pair.baseToken.address}</code> <i>(Tap to copy)</i>

💵 <b>Harga:</b> ${formatPrice(priceNum)} <code>(${pair.priceChange?.m5 >= 0 ? '+' : ''}${pair.priceChange?.m5 || 0}% 5m | ${pair.priceChange?.h1 >= 0 ? '+' : ''}${pair.priceChange?.h1 || 0}% 1h)</code>
💧 <b>Likuiditas:</b> ${formatUsd(pair.liquidity?.usd || 0)}
📊 <b>Volume 5m:</b> ${formatUsd(pair.volume?.m5 || 0)}

🛡️ <b>Safety Score:</b> ${levelEmoji} <b>${security.score}/100</b> [${security.level}]
${progressBar}
${flagList}
${aiSection}
🕒 <i>Diperbarui: ${new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</i>
<i>⚠️ DYOR. Bukan nasihat finansial.</i>
`.trim();
}
