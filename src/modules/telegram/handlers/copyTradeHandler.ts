import { Context, InlineKeyboard } from 'grammy';
import { CopyTradeRepository } from '../../../database/repositories/copyTradeRepository';

export async function handleCopyTradeMenu(
  ctx: Context,
  copyTradeRepo: CopyTradeRepository
): Promise<void> {
  if (!ctx.from) return;

  const targets = await copyTradeRepo.getTargetsByUserId(ctx.from.id);
  const activeCount = targets.filter(t => t.is_active).length;

  let text = `
🎯 <b>SMART MONEY / COPY TRADING</b>

Anda sedang memantau <b>${targets.length}</b> dompet paus (Active: ${activeCount}).
Gunakan perintah berikut untuk mengelola target Anda:

<code>/copy add &lt;wallet_address&gt; &lt;max_usd&gt; [label]</code>
Contoh: <code>/copy add 8ZCm...pump 10 PausUtama</code>

<code>/copy rm &lt;wallet_address&gt;</code>
Contoh: <code>/copy rm 8ZCm...pump</code>

<b>Daftar Target Anda:</b>
`;

  if (targets.length === 0) {
    text += `<i>Belum ada dompet target. Silakan tambahkan!</i>`;
  } else {
    for (const t of targets) {
      const status = t.is_active ? '🟢' : '🔴';
      const label = t.label ? ` (${t.label})` : '';
      text += `${status} <code>${t.target_wallet_address.slice(0, 4)}...${t.target_wallet_address.slice(-4)}</code>${label} | $${t.max_buy_usd}\n`;
    }
  }

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh', 'copytrade_refresh')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handleCopyTradeCommand(
  ctx: Context,
  copyTradeRepo: CopyTradeRepository
): Promise<void> {
  if (!ctx.from || !ctx.message || !ctx.message.text) return;

  const args = ctx.message.text.split(' ').slice(1);
  const action = args[0]?.toLowerCase();

  if (!action || action === 'list') {
    await handleCopyTradeMenu(ctx, copyTradeRepo);
    return;
  }

  if (action === 'add') {
    const walletAddress = args[1];
    const maxUsd = parseFloat(args[2]);
    const label = args.slice(3).join(' ');

    if (!walletAddress || isNaN(maxUsd)) {
      await ctx.reply('❌ <b>Format salah!</b>\nGunakan: <code>/copy add &lt;wallet_address&gt; &lt;max_usd&gt; [label]</code>', { parse_mode: 'HTML' });
      return;
    }

    try {
      await copyTradeRepo.addTarget(ctx.from.id, walletAddress, maxUsd, label);
      await ctx.reply(`✅ <b>Berhasil menambahkan dompet!</b>\nTarget: <code>${walletAddress}</code>\nMaksimal Beli: $${maxUsd}`, { parse_mode: 'HTML' });
      await handleCopyTradeMenu(ctx, copyTradeRepo);
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`);
    }
  } else if (action === 'rm' || action === 'remove') {
    const walletAddress = args[1];
    if (!walletAddress) {
      await ctx.reply('❌ <b>Format salah!</b>\nGunakan: <code>/copy rm &lt;wallet_address&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    try {
      await copyTradeRepo.removeTarget(ctx.from.id, walletAddress);
      await ctx.reply(`✅ <b>Berhasil menghapus dompet:</b> <code>${walletAddress}</code>`, { parse_mode: 'HTML' });
      await handleCopyTradeMenu(ctx, copyTradeRepo);
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`);
    }
  } else {
    await ctx.reply('❌ Perintah tidak dikenal. Coba `/copy list`, `/copy add`, atau `/copy rm`.', { parse_mode: 'Markdown' });
  }
}
