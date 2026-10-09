import { InlineKeyboard } from 'grammy';

export function createTokenKeyboard(tokenMint: string, isDryRun: boolean = true): InlineKeyboard {
  const modeTag = isDryRun ? '[PAPER] ' : '';
  return new InlineKeyboard()
    .text(`💰 ${modeTag}0.01`, `buy:${tokenMint}:0.01`)
    .text(`💰 ${modeTag}0.05`, `buy:${tokenMint}:0.05`)
    .text(`💰 ${modeTag}0.1`, `buy:${tokenMint}:0.1`)
    .row()
    .text(`💰 ${modeTag}0.5`, `buy:${tokenMint}:0.5`)
    .text(`💰 Custom`, `buy_custom:${tokenMint}`)
    .row()
    .text(`🔄 Refresh`, `refresh:${tokenMint}`)
    .url(`📊 Chart`, `https://dexscreener.com/solana/${tokenMint}`)
    .url(`🔍 Solscan`, `https://solscan.io/token/${tokenMint}`)
    .row()
    .text(`🤖 Autopilot`, `menu_autopilot`)
    .text(`🏠 Menu`, `menu_main`);
}

export function createMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔍 Scan Token', 'menu_scan')
    .text('💳 Wallet & Deposit', 'menu_wallet')
    .row()
    .text('🤖 Autopilot', 'menu_autopilot')
    .text('📊 Positions', 'menu_positions')
    .row()
    .text('⚙️ Settings', 'menu_settings')
    .text('❓ Bantuan', 'menu_help');
}
