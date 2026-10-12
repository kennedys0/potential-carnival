import { Resvg } from '@resvg/resvg-js';

export interface PnlCardData {
  tokenSymbol: string;
  tokenMint: string;
  isProfit: boolean;
  pnlPercent: number;
  pnlSol: number;
  pnlIdrText?: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  solAmount: number;
  isDryRun: boolean;
  strategy?: string;
  status?: string;
  timestampText?: string;
}

function xmlEscape(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class PnlCardGenerator {
  static generateCardSvg(data: PnlCardData): string {
    const isProfit = data.pnlPercent >= 0;
    const accentColor = isProfit ? '#00FFA3' : '#FF3B69';
    const accentGlow = isProfit ? 'rgba(0, 255, 163, 0.25)' : 'rgba(255, 59, 105, 0.25)';
    const bgGlow = isProfit ? '#064E3B' : '#7F1D1D';
    const sign = isProfit ? '+' : '';
    const formattedPercent = `${sign}${data.pnlPercent.toFixed(2)}%`;
    const formattedSol = `${sign}${data.pnlSol.toFixed(4)} SOL`;
    const idrText = data.pnlIdrText ? xmlEscape(data.pnlIdrText) : '';
    const symbol = xmlEscape(data.tokenSymbol.toUpperCase());
    const shortMint = data.tokenMint
      ? `${data.tokenMint.slice(0, 6)}...${data.tokenMint.slice(-4)}`
      : 'UNKNOWN';
    const modeBadge = data.isDryRun ? 'PAPER TRADING' : 'LIVE TRADING';
    const modeBg = data.isDryRun ? '#065F46' : '#9945FF';
    const strategyName = xmlEscape(data.strategy || 'AUTOPILOT');
    const timestamp = xmlEscape(
      data.timestampText ||
        new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB'
    );

    // Multiplier calculation
    const multValue = data.entryPriceUsd > 0 ? (data.currentPriceUsd / data.entryPriceUsd) : 1;
    const multiplier = `${multValue.toFixed(2)}x`;

    const formatPrice = (p: number) => {
      if (p <= 0) return '$0.00';
      if (p < 0.0001) return `$${p.toFixed(8)}`;
      if (p < 0.01) return `$${p.toFixed(6)}`;
      if (p < 1) return `$${p.toFixed(4)}`;
      return `$${p.toFixed(2)}`;
    };

    const entryPrice = formatPrice(data.entryPriceUsd);
    const exitPrice = formatPrice(data.currentPriceUsd);
    const solSize = `${data.solAmount.toFixed(2)} SOL`;

    return `
<svg width="1200" height="675" viewBox="0 0 1200 675" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background Gradient -->
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1200" y2="675" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#080C14" />
      <stop offset="50%" stop-color="#0F172A" />
      <stop offset="100%" stop-color="#050810" />
    </linearGradient>

    <!-- Ambient Glow Top Right -->
    <radialGradient id="radialAccent" cx="80%" cy="20%" r="60%">
      <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.18" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </radialGradient>

    <!-- Ambient Solana Purple Glow Bottom Left -->
    <radialGradient id="radialPurple" cx="15%" cy="85%" r="50%">
      <stop offset="0%" stop-color="#9945FF" stop-opacity="0.12" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </radialGradient>

    <!-- Card Glass Border Gradient -->
    <linearGradient id="cardBorder" x1="0" y1="0" x2="1200" y2="675" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.6" />
      <stop offset="50%" stop-color="#334155" stop-opacity="0.3" />
      <stop offset="100%" stop-color="#9945FF" stop-opacity="0.4" />
    </linearGradient>

    <!-- Solana Gradient for Badges -->
    <linearGradient id="solanaGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#9945FF" />
      <stop offset="100%" stop-color="#14F195" />
    </linearGradient>
  </defs>

  <!-- Base Background -->
  <rect width="1200" height="675" fill="url(#bgGrad)" />
  <rect width="1200" height="675" fill="url(#radialAccent)" />
  <rect width="1200" height="675" fill="url(#radialPurple)" />

  <!-- Outer Glass Frame -->
  <rect x="24" y="24" width="1152" height="627" rx="28" stroke="url(#cardBorder)" stroke-width="2" fill="#0F172A" fill-opacity="0.4" />

  <!-- Corner Tech Accents -->
  <path d="M 24 64 L 24 24 L 64 24" stroke="${accentColor}" stroke-width="4" stroke-linecap="round" fill="none" />
  <path d="M 1176 64 L 1176 24 L 1136 24" stroke="${accentColor}" stroke-width="4" stroke-linecap="round" fill="none" />
  <path d="M 24 611 L 24 651 L 64 651" stroke="#9945FF" stroke-width="4" stroke-linecap="round" fill="none" />
  <path d="M 1176 611 L 1176 651 L 1136 651" stroke="#14F195" stroke-width="4" stroke-linecap="round" fill="none" />

  <!-- HEADER AREA -->
  <!-- Brand Logo & Name -->
  <text x="64" y="78" font-family="system-ui, -apple-system, sans-serif" font-weight="900" font-size="24" fill="#FFFFFF" letter-spacing="1">POTENTIAL CARNIVAL</text>
  <text x="64" y="100" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="13" fill="#94A3B8" letter-spacing="2">SOLANA HIGH-FREQUENCY SCALPER</text>

  <!-- Header Badges -->
  <!-- Strategy Badge -->
  <rect x="830" y="60" width="130" height="34" rx="17" fill="#1E293B" stroke="#334155" stroke-width="1.5" />
  <text x="895" y="82" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="12" fill="#E2E8F0" text-anchor="middle" letter-spacing="1">${strategyName}</text>

  <!-- Mode Badge -->
  <rect x="976" y="60" width="160" height="34" rx="17" fill="${modeBg}" />
  <circle cx="994" cy="77" r="5" fill="#FFFFFF" />
  <text x="1064" y="82" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="12" fill="#FFFFFF" text-anchor="middle" letter-spacing="1">${modeBadge}</text>

  <!-- HERO STAT SECTION -->
  <!-- Token Info -->
  <g transform="translate(64, 160)">
    <rect x="0" y="0" width="100" height="32" rx="16" fill="${accentColor}" fill-opacity="0.15" stroke="${accentColor}" stroke-width="1" />
    <text x="50" y="21" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="14" fill="${accentColor}" text-anchor="middle">TOKEN</text>
    
    <text x="116" y="24" font-family="system-ui, -apple-system, sans-serif" font-weight="900" font-size="34" fill="#FFFFFF">${symbol}</text>
    <text x="116" y="48" font-family="system-ui, -apple-system, sans-serif" font-weight="500" font-size="15" fill="#64748B">CA: ${shortMint}</text>
  </g>

  <!-- MAIN PNL NUMBER (HERO) -->
  <text x="64" y="325" font-family="system-ui, -apple-system, sans-serif" font-weight="900" font-size="108" fill="${accentColor}" letter-spacing="-2">
    ${formattedPercent}
  </text>

  <!-- PNL IN SOL & FIAT -->
  <g transform="translate(64, 375)">
    <rect x="0" y="-24" width="12" height="24" rx="4" fill="${accentColor}" />
    <text x="24" y="-3" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="28" fill="#F8FAFC">
      ${formattedSol} <tspan font-weight="600" font-size="20" fill="#94A3B8">${idrText ? `(${idrText})` : ''}</tspan>
    </text>
  </g>

  <!-- STATS CARDS GRID -->
  <!-- Box 1: Entry Price -->
  <g transform="translate(64, 435)">
    <rect width="250" height="110" rx="18" fill="#1E293B" fill-opacity="0.6" stroke="#334155" stroke-width="1.5" />
    <text x="24" y="36" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="13" fill="#94A3B8" letter-spacing="1">ENTRY PRICE</text>
    <text x="24" y="78" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="26" fill="#F1F5F9">${entryPrice}</text>
  </g>

  <!-- Box 2: Current / Exit Price -->
  <g transform="translate(338, 435)">
    <rect width="250" height="110" rx="18" fill="#1E293B" fill-opacity="0.6" stroke="#334155" stroke-width="1.5" />
    <text x="24" y="36" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="13" fill="#94A3B8" letter-spacing="1">MARKET PRICE</text>
    <text x="24" y="78" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="26" fill="${accentColor}">${exitPrice}</text>
  </g>

  <!-- Box 3: Trade Size -->
  <g transform="translate(612, 435)">
    <rect width="250" height="110" rx="18" fill="#1E293B" fill-opacity="0.6" stroke="#334155" stroke-width="1.5" />
    <text x="24" y="36" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="13" fill="#94A3B8" letter-spacing="1">TRADE SIZE</text>
    <text x="24" y="78" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="26" fill="#F1F5F9">${solSize}</text>
  </g>

  <!-- Box 4: Multiplier -->
  <g transform="translate(886, 435)">
    <rect width="250" height="110" rx="18" fill="#1E293B" fill-opacity="0.6" stroke="${accentColor}" stroke-opacity="0.4" stroke-width="1.5" />
    <text x="24" y="36" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="13" fill="#94A3B8" letter-spacing="1">RETURN MULTIPLIER</text>
    <text x="24" y="78" font-family="system-ui, -apple-system, sans-serif" font-weight="900" font-size="30" fill="${accentColor}">${multiplier}</text>
  </g>

  <!-- FOOTER BAR -->
  <line x1="64" y1="585" x2="1136" y2="585" stroke="#334155" stroke-width="1" opacity="0.6" />

  <text x="64" y="618" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="13" fill="#64748B" letter-spacing="0.5">
    VERIFIED ON SOLANA BLOCKCHAIN • @solana_scalper_bot
  </text>

  <text x="1136" y="618" font-family="system-ui, -apple-system, sans-serif" font-weight="500" font-size="13" fill="#64748B" text-anchor="end">
    ${timestamp}
  </text>
</svg>
`.trim();
  }

  static async generateCardBuffer(data: PnlCardData): Promise<Buffer> {
    const svg = this.generateCardSvg(data);
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: 1200 },
      font: {
        loadSystemFonts: true,
        defaultFontFamily: 'sans-serif',
      },
    });
    const pngData = resvg.render();
    return Buffer.from(pngData.asPng());
  }
}
