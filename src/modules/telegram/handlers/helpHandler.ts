import { Context, InlineKeyboard } from 'grammy';

export async function handleHelpMenu(ctx: Context): Promise<void> {
  const text = `
❓ <b>Panduan & Bantuan Solana Scalping Bot</b>

🤖 <b>Daftar Perintah:</b>
• <code>/start</code> - Membuka menu utama & membuat wallet Solana terenkripsi
• <code>/scan &lt;CA&gt;</code> - Analisis token on-chain real-time + AI scalping verdict
• <code>/wallet</code> - Cek saldo SOL, deposit QR code & kelola wallet
• <code>/autopilot</code> - Pengaturan dan dashboard auto-trading
• <code>/positions</code> - Pantau posisi trade yang sedang aktif
• <code>/settings</code> - Ubah mode Paper Trading / Live, ukuran trade, dsb.

🛡️ <b>Fitur Keamanan Unggulan:</b>
1. <b>Anti-Rug Multi-Layer:</b> Deteksi otomatis mint authority aktif, freeze authority, konsentrasi top 10 holders, LP burn/lock status, dan Token-2022 transfer fee tax.
2. <b>AI Scalping Analyzer:</b> Evaluasi teknikal (RSI, EMA crossover, Volume surge, Risk:Reward) menggunakan Zod schema strict.
3. <b>Enkripsi AES-256-GCM:</b> Private key disimpan terenkripsi dengan kunci master acak dan IV unik.
4. <b>Safety First:</b> Selalu default ke <b>Paper Trading (Simulasi)</b> sebelum Anda mengaktifkan Live On-Chain.

Butuh bantuan lebih lanjut? Hubungi admin bot.
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔍 Coba Scan Token', 'menu_scan')
    .text('💳 Cek Wallet', 'menu_wallet')
    .row()
    .text('🏠 Menu Utama', 'menu_main');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
