import { InlineKeyboard } from 'grammy';

export function createTokenKeyboard(tokenMint: string, isDryRun: boolean = true): InlineKeyboard {
  const prefix = isDryRun ? '🟢 ' : '⚡ ';
  return new InlineKeyboard()
    .text(`${prefix}0.05 SOL`, `buy:${tokenMint}:0.05`)
    .text(`${prefix}0.10 SOL`, `buy:${tokenMint}:0.1`)
    .text(`${prefix}0.25 SOL`, `buy:${tokenMint}:0.25`)
    .row()
    .text(`${prefix}0.50 SOL`, `buy:${tokenMint}:0.5`)
    .text('✍️ Custom SOL', `buy_custom:${tokenMint}`)
    .row()
    .text('🔄 Refresh', `refresh:${tokenMint}`)
    .url('📊 DexScreener', `https://dexscreener.com/solana/${tokenMint}`)
    .url('🔍 Solscan', `https://solscan.io/token/${tokenMint}`)
    .row()
    .text('🤖 Autopilot', 'menu_autopilot')
    .text('🏠 Dashboard', 'menu_main');
}

export function createMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔍 Scan Token', 'menu_scan')
    .text('📊 Portofolio', 'menu_positions')
    .row()
    .text('💳 Dompet & Saldo', 'menu_wallet')
    .text('🤖 Autopilot', 'menu_autopilot')
    .row()
    .text('⚙️ Pengaturan', 'menu_settings')
    .text('📈 Laporan Hari Ini', 'menu_report')
    .row()
    .text('❓ Panduan & Bantuan', 'menu_help');
}

export function createBackToHomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🏠 Dashboard Utama', 'menu_main');
}

