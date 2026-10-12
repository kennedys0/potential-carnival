import { InlineKeyboard } from 'grammy';
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

export function formatRadarFriendlyReason(reason: string): string {
  if (!reason) return 'Kondisi pasar belum memenuhi kriteria';
  const lower = reason.toLowerCase();

  if (lower.includes('volatile') || lower.includes('low confidence')) {
    return 'Kondisi teknikal & momentum belum terkonfirmasi';
  }
  if (lower.includes('invalid pool creation time')) {
    return 'Waktu pembuatan pool tidak valid';
  }
  if (lower.includes('belum masuk target window') || lower.includes('pool age')) {
    return 'Umur pool masih di luar rentang target sniping';
  }
  if (lower.includes('belum sinkron') || lower.includes('belum valid')) {
    return 'Data pool belum tersinkronisasi di DexScreener';
  }
  if (lower.includes('likuiditas atau harga kosong')) {
    return 'Data likuiditas atau harga masih kosong';
  }
  if (lower.includes('gagal tes anti-rug') || lower.includes('anti-rug')) {
    return reason; // Keep specific anti-rug failure details
  }
  if (lower.includes('rute jual') || lower.includes('sell route')) {
    return 'Rute jual (sell route) belum tersedia di router DEX';
  }
  if (lower.includes('di bawah target')) {
    return reason;
  }
  if (lower.includes('daily max buys') || lower.includes('batas harian')) {
    return 'Batas kuota transaksi harian telah tercapai';
  }
  if (lower.includes('max active positions') || lower.includes('posisi aktif')) {
    return 'Batas jumlah posisi aktif maksimum telah tercapai';
  }
  if (lower.includes('daily budget')) {
    return 'Batas anggaran modal harian tercapai';
  }
  if (lower.includes('cooldown')) {
    return 'Masa jeda (cooldown) antar order masih aktif';
  }
  if (lower.includes('circuit breaker')) {
    return 'Pengaman darurat (Circuit Breaker) sedang aktif';
  }

  return reason;
}

export interface RadarCandidateParams {
  type: 'TRENDING' | 'SNIPER';
  symbol: string;
  name?: string;
  tokenAddress: string;
  pairAddress?: string;
  priceUsd?: number | null;
  liquidityUsd?: number | null;
  volume5mUsd?: number | null;
  poolAgeText?: string | null;
  securityScore?: number | null;
  securityLevel?: string | null;
  riskFlags?: string[];
  status: 'SKIPPED' | 'EXECUTED' | 'ALERT';
  reason: string;
}

export function formatRadarCandidate(params: RadarCandidateParams): string {
  const isSniper = params.type === 'SNIPER';
  const header = isSniper ? '⚡ <b>SNIPER RADAR</b>' : '📡 <b>AUTOPILOT RADAR</b>';
  const displayName = params.name ? `${params.name} ($${params.symbol})` : `$${params.symbol}`;

  let statusBadge = '<b>⚪ DILEWATI (SKIPPED)</b>';
  if (params.status === 'EXECUTED') {
    statusBadge = '<b>🟢 EKSEKUSI BUY</b>';
  } else if (params.status === 'ALERT') {
    statusBadge = '<b>🟡 RADAR SIGNAL DETECTED</b>';
  }

  const lines: string[] = [
    header,
    UI_DIVIDER,
    `💎 <b>${escapeHtml(displayName)}</b>`,
    `<code>${escapeHtml(params.tokenAddress)}</code> <i>(Tap to copy)</i>`,
  ];

  // Metrics Section
  const metrics: string[] = [];
  if (typeof params.priceUsd === 'number' && Number.isFinite(params.priceUsd)) {
    metrics.push(`• <b>Harga:</b> <code>${formatPrice(params.priceUsd)}</code>`);
  }
  if (typeof params.liquidityUsd === 'number' && Number.isFinite(params.liquidityUsd)) {
    metrics.push(`• <b>Likuiditas:</b> <code>${formatUsd(params.liquidityUsd)}</code>`);
  }
  if (params.poolAgeText) {
    metrics.push(`• <b>Umur Pool:</b> <code>${escapeHtml(params.poolAgeText)}</code>`);
  }
  if (typeof params.volume5mUsd === 'number' && Number.isFinite(params.volume5mUsd)) {
    metrics.push(`• <b>Volume 5m:</b> <code>${formatUsd(params.volume5mUsd)}</code>`);
  }

  if (metrics.length > 0) {
    lines.push('', '📊 <b>Metrik On-Chain:</b>', ...metrics);
  }

  // Security Section
  if (typeof params.securityScore === 'number' && Number.isFinite(params.securityScore)) {
    let levelEmoji = '🔴';
    if (params.securityScore >= 75) levelEmoji = '🟢';
    else if (params.securityScore >= 50) levelEmoji = '🟡';

    const scoreBar = formatProgressBar(params.securityScore, 100, 8);
    lines.push(
      '',
      `🛡️ <b>Audit Keamanan Anti-Rug:</b>`,
      `• <b>Skor:</b> ${levelEmoji} <b>${params.securityScore}/100</b> [${escapeHtml(params.securityLevel || 'CHECKED')}]`,
      `• <b>Rating:</b> <code>${scoreBar}</code>`
    );

    if (params.riskFlags && params.riskFlags.length > 0) {
      const shownFlags = params.riskFlags.slice(0, 2).map(escapeHtml).join(', ');
      const suffix = params.riskFlags.length > 2 ? ', dll' : '';
      lines.push(`• <b>Flags:</b> ⚠️ <i>${shownFlags}${suffix}</i>`);
    }
  }

  // Status & Decision
  const friendlyReason = formatRadarFriendlyReason(params.reason);
  lines.push(
    '',
    UI_DIVIDER,
    `📋 <b>Status:</b> ${statusBadge}`,
    `📝 <b>Analisa:</b> <i>${escapeHtml(friendlyReason)}</i>`
  );

  return lines.join('\n').trim();
}

export function buildRadarCandidateKeyboard(
  tokenAddress: string,
  pairAddress?: string,
  executed: boolean = false
): InlineKeyboard {
  const chartTarget = pairAddress || tokenAddress;
  const keyboard = new InlineKeyboard()
    .text('🔍 Scan Mendalam', `refresh:${tokenAddress}`)
    .url('📈 DexScreener', `https://dexscreener.com/solana/${chartTarget}`);

  if (executed) {
    keyboard.row().text('📊 Cek Portofolio', 'menu_positions');
  }

  return keyboard;
}

export interface RadarCycleDigestParams {
  type: 'TRENDING' | 'SNIPER';
  scannedCount: number;
  passedSafetyCount?: number;
  executedCount?: number;
}

export function formatRadarCycleDigest(params: RadarCycleDigestParams): string {
  const isSniper = params.type === 'SNIPER';
  const typeLabel = isSniper ? '⚡ New Token Pools (Sniper)' : '📈 Trending Token Momentum';
  const timeStr = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });
  const execCount = params.executedCount ?? 0;
  const execNote = execCount > 0 ? ` 🚀 <b>(${execCount} order diproses)</b>` : ' <i>(Kondisi pasar wait-and-see)</i>';

  const lines = [
    `🔄 <b>RINGKASAN SIKLUS RADAR</b>`,
    UI_DIVIDER,
    `⏱ <b>Waktu:</b> <code>${timeStr} WIB</code>`,
    `📡 <b>Kategori:</b> <b>${typeLabel}</b>`,
    `🔍 <b>Token Dipindai:</b> <code>${params.scannedCount} Pair</code>`,
  ];

  if (typeof params.passedSafetyCount === 'number') {
    lines.push(`🛡️ <b>Lolos Anti-Rug:</b> <code>${params.passedSafetyCount} Pair</code>`);
  }

  lines.push(
    `🎯 <b>Eksekusi Buy:</b> <code>${execCount} Order</code>${execNote}`,
    UI_DIVIDER,
    `<i>Radar terus aktif memantau pergerakan on-chain di latar belakang...</i>`
  );

  return lines.join('\n').trim();
}

export interface RadarHubParams {
  isLiveFeedActive: boolean;
  isTrendingActive: boolean;
  isSniperActive: boolean;
  trendingSizeSol: number;
  sniperSizeSol: number;
}

export function formatRadarHub(params: RadarHubParams): string {
  const liveFeedTag = params.isLiveFeedActive ? '🟢 AKTIF (Menerima Feed)' : '🔕 NONAKTIF (Hening)';
  const trendTag = params.isTrendingActive ? '🟢 BERJALAN' : '⏸ JEDA';
  const sniperTag = params.isSniperActive ? '🟢 BERJALAN' : '🔴 NONAKTIF';
  const timeStr = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });

  return `
📡 <b>RADAR LIVE FEED COMMAND HUB</b>
${UI_DIVIDER}
Radar memantau pergerakan pasar Solana secara real-time. Setiap siklus, token dievaluasi dengan filter Anti-Rug, analisis teknikal, dan aturan eksekusi otomatis.

⚙️ <b>Status Monitoring Real-Time:</b>
• <b>Notifikasi Live Feed:</b> ${liveFeedTag}
• <b>Autopilot Trending:</b> ${trendTag} <i>(${params.trendingSizeSol} SOL/trade)</i>
• <b>New Pool Sniper:</b> ${sniperTag} <i>(${params.sniperSizeSol} SOL/trade)</i>

${UI_DIVIDER}
🕒 <i>Status Terkini: ${timeStr} WIB</i>
<i>Tekan tombol di bawah untuk toggle notifikasi atau membuka konfigurasi:</i>
`.trim();
}

export function buildRadarHubKeyboard(isLiveFeedActive: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(isLiveFeedActive ? '🔕 Matikan Live Feed' : '🔔 Aktifkan Live Feed', 'toggle_livefeed')
    .row()
    .text('🤖 Set Autopilot', 'menu_autopilot')
    .text('⚡ Set Sniper', 'sniper_settings')
    .row()
    .text('🔄 Refresh Status', 'radar_refresh')
    .text('🏠 Dashboard', 'menu_main');
}
