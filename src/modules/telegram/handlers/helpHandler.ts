import { Context, InlineKeyboard } from 'grammy';

export async function handleHelpMenu(ctx: Context): Promise<void> {
  const text = `
📖 <b>PANDUAN LENGKAP BOT TRADING SOLANA</b>
───────────────────────────
🚀 <b>3 Langkah Mudah Memulai:</b>
1️⃣ <b>Mulai dengan Aman:</b> Bot default dalam mode <b>Paper Trading (Simulasi)</b>. Anda bisa mencoba scan dan trading tanpa risiko modal riil.
2️⃣ <b>Analisis Token Instan:</b> Kirimkan Contract Address (CA) token Solana langsung di chat ini untuk audit anti-rug dan sinyal AI dalam 2 detik.
3️⃣ <b>Gunakan Otomasi Cerdas:</b> Buka <code>/autopilot</code> untuk auto-snipe token trending atau pool likuiditas yang baru dibuat.

───────────────────────────
📋 <b>Daftar Perintah Cepat:</b>
• <code>/dashboard</code> - Ringkasan performa & akun
• <code>/scan &lt;CA&gt;</code> - Analisis token & tombol Quick Buy
• <code>/positions</code> - Pantau posisi aktif & PnL live
• <code>/autopilot</code> - Kontrol bot trending & sniper
• <code>/wallet</code> - Cek saldo, QR deposit & withdraw
• <code>/settings</code> - Atur ukuran trade, SL/TP, trailing stop
• <code>/report</code> - Laporan harian profit/loss
• <code>/radar</code> atau <code>/livefeed</code> - Radar Command Hub & live feed

───────────────────────────
🛡️ <b>Proteksi Keamanan:</b>
• <b>Anti-Rug Multi-Layer:</b> Honeypot filter, freeze/mint authority check, dan LP burn/lock verification.
• <b>Risk Management:</b> Circuit Breaker otomatis membatasi kerugian harian.
• <b>Enkripsi AES-256-GCM:</b> Kunci wallet disimpan terenkripsi dengan aman.
`.trim();

  const keyboard = new InlineKeyboard()
    .text('🔍 Scan Token', 'menu_scan')
    .text('📊 Cek Portofolio', 'menu_positions')
    .row()
    .text('💳 Dompet & Saldo', 'menu_wallet')
    .text('⚙️ Pengaturan', 'menu_settings')
    .row()
    .text('🏠 Dashboard Utama', 'menu_main');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
