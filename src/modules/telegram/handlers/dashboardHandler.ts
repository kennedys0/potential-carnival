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
  const modeBadge = isPaper ? '🟢 [PAPER]' : '⚡ [LIVE]';
  const autopilotStatus = config.is_active ? '🟢 AKTIF' : '⏸ JEDA';
  const cbStatus = stats.isCircuitBroken ? '🔴 TERPICU' : '🟢 AMAN';
  const pnlSign = stats.dailyRealizedPnlSol >= 0 ? '+' : '';
  const pnlIdr = currencyService.solToIdr(stats.dailyRealizedPnlSol);
  const balanceIdr = currencyService.solToIdr(balance.sol);
  
  const text = `
📊 <b>DASHBOARD</b>

<b>Status Sistem</b>
• Mode: ${modeBadge}
• Autopilot: ${autopilotStatus}
• Risiko: ${cbStatus} (Harian: ${pnlSign}${stats.dailyRealizedPnlSol.toFixed(4)} SOL ≈ ${pnlSign}${currencyService.formatIdr(pnlIdr)})

<b>Dompet & Portofolio</b>
• Saldo: <code>${balance.sol.toFixed(4)} SOL</code> (≈ ${currencyService.formatIdr(balanceIdr)})
• Posisi Aktif: <b>${openTrades.length} Terbuka</b>

<i>Gunakan menu di bawah untuk navigasi cepat:</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text('📊 Portfolio', 'menu_positions')
    .text('💳 Wallet', 'menu_wallet')
    .row()
    .text('🤖 Autopilot', 'menu_autopilot')
    .text('⚙️ Settings', 'menu_settings')
    .row()
    .text('🔄 Refresh', 'menu_main');

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
