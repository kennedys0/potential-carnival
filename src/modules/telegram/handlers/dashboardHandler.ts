import { Context, InlineKeyboard } from 'grammy';
import { UserRepository } from '../../../database/repositories/userRepository';
import { AutopilotRepository } from '../../../database/repositories/autopilotRepository';
import { TradeRepository } from '../../../database/repositories/tradeRepository';
import { WalletService } from '../../wallet/walletService';
import { currencyService } from '../../../utils/currencyService';

export async function handleDashboardMenu(
  ctx: Context,
  userRepo: UserRepository,
  autopilotRepo: AutopilotRepository,
  tradeRepo: TradeRepository,
  walletService: WalletService
): Promise<void> {
  if (!ctx.from) return;

  // Initialize/Get User & Wallet
  await userRepo.getOrCreateUser(ctx.from.id, ctx.from.username);
  const wallet = await walletService.getOrCreateWallet(ctx.from.id);
  const balance = await walletService.getBalance(wallet.publicKey);
  
  // Get State & Trades
  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const stats = await autopilotRepo.getStats(ctx.from.id);
  const openTrades = await tradeRepo.getOpenTradesByUserId(ctx.from.id);
  
  // Computed values
  const isPaper = config.mode === 'PAPER';
  const modeBadge = isPaper ? '🟢 [PAPER] (Simulasi)' : '⚡ [LIVE] (On-Chain)';
  const autopilotStatus = config.is_active ? '🟢 AKTIF' : '⏸ JEDA';
  const cbStatus = stats.isCircuitBroken ? '🔴 TERPICU' : '🟢 AMAN';
  const pnlSign = stats.dailyRealizedPnlSol >= 0 ? '+' : '';
  const pnlIdr = currencyService.solToIdr(stats.dailyRealizedPnlSol);
  const pnlIdrStr = pnlIdr !== null ? ` (≈ ${pnlSign}${currencyService.formatIdr(pnlIdr)})` : '';
  const balanceIdr = currencyService.solToIdr(balance.sol);
  const balanceIdrStr = balanceIdr !== null ? ` (≈ ${currencyService.formatIdr(balanceIdr)})` : '';

  const shortPubkey = `${wallet.publicKey.slice(0, 4)}...${wallet.publicKey.slice(-4)}`;
  const timeStr = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });

  const text = `
💎 <b>DASHBOARD UTAMA</b>
───────────────────────────
⚙️ <b>Status Sistem & Risiko</b>
• <b>Mode:</b> ${modeBadge}
• <b>Autopilot:</b> ${autopilotStatus}
• <b>Circuit Breaker:</b> ${cbStatus}
• <b>Realized PnL:</b> <code>${pnlSign}${stats.dailyRealizedPnlSol.toFixed(4)} SOL</code>${pnlIdrStr}

💳 <b>Dompet & Saldo</b>
• <b>Saldo:</b> <code>${balance.sol.toFixed(4)} SOL</code>${balanceIdrStr}
• <b>Wallet:</b> <code>${wallet.publicKey}</code> <i>(Tap to copy)</i>

📊 <b>Portofolio Trading</b>
• <b>Posisi Terbuka:</b> <b>${openTrades.length} Posisi Aktif</b>
───────────────────────────
🕒 <i>Diperbarui: ${timeStr} WIB</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔍 Scan Token', 'menu_scan')
    .text(`📊 Portofolio (${openTrades.length})`, 'menu_positions')
    .row()
    .text('💳 Dompet & Saldo', 'menu_wallet')
    .text('🤖 Autopilot', 'menu_autopilot')
    .row()
    .text('⚙️ Pengaturan', 'menu_settings')
    .text('📈 Laporan', 'menu_report')
    .row()
    .text('🔄 Refresh Dashboard', 'menu_main');

  if (ctx.callbackQuery) {
    const isPhoto = ctx.callbackQuery.message && 'caption' in ctx.callbackQuery.message;
    try {
      if (isPhoto) {
         // Cannot easily switch from Photo to text with editMessageText if it's a photo, so delete and resend
         await ctx.deleteMessage();
         await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
      if (err?.description?.includes('message to edit not found')) {
         await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
