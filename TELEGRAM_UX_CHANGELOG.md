# TELEGRAM UX CHANGELOG

## Comprehensive UI/UX Overhaul & Modernization

### 1. Desain Visual Lebih Menarik & Mudah Dibaca (Aesthetics & Scannability)
- **Visual Dividers & Structured Cards**: Menggunakan divider seragam `───────────────────────────` dan struktur hierarki informasi (Header, Badges, Metrics, Actions, Footnotes).
- **Token Scanner Modernization (`messageFormatter.ts`)**:
  - Tampilan audit dipisah menjadi 4 blok jelas: Info Token, Metrik Pasar (Harga, % 5m/1h, Likuiditas, Volume), Skor Anti-Rug, dan Analisa AI Scalping.
  - Skor Anti-Rug menampilkan progress bar visual `▰▰▰▰▰▰▰▰▱▱ 85/100` serta checklist audit on-chain yang rapi.
  - Sinyal AI scalping kini menampilkan Verdict, Keyakinan %, Stop Loss, R:R, serta poin-poin alasan teknikal yang terstruktur.
- **Tampilan Portofolio & Posisi Aktif (`positionsHandler.ts`)**:
  - Tombol posisi inline kini menampilkan PnL langsung di tombolnya, e.g. `[🟢 BONK (+14.2%)]` atau `[🔴 WIF (-3.1%)]`, sehingga pengguna bisa langsung melihat performa tanpa harus membuka satu per satu.
  - Menambahkan aksi parsial `[🟠 Jual Sebagian (50%)]` selain `[🔴 Jual Semua (100%)]` dan link langsung ke DexScreener chart.
  - Empty state portofolio kini dilengkapi tombol aksi cepat `[🔍 Scan Token Baru]` dan `[🤖 Nyalakan Autopilot]` agar pengguna tidak terjebak di jalan buntu.

### 2. Pengaturan Mudah & Interaktif (Easy & Granular Settings)
- **Modular Sub-Menus (`settingsHandler.ts` & `router.ts`)**:
  - Mengubah menu pengaturan yang sebelumnya berupa 15 tombol padat menjadi menu bertingkat yang bersih dan teratur:
    1. **Ukuran Trade (`settings_menu_size`)**: Menampilkan pilihan preset dengan tanda centang aktif `[✓ 0.10 SOL]` dan opsi input kustom `[✍️ Input Nominal Custom]`.
    2. **Profil Risiko (`settings_menu_risk`)**: Menjelaskan profil Konservatif, Moderat, dan Agresif dengan indikator aktif `✓`.
    3. **TP & Stop Loss (`settings_menu_tpsl`)**: Selector Stop Loss (-5%, -8%, -10%, -15%, -20%) dan Take Profit (+10%, +15%, +25%, +50%, +100%) dengan feedback aktif.
    4. **Trailing Stop (`settings_menu_trailing`)**: Kontrol toggle ON/OFF, jarak trailing, dan persentase profit aktivasi awal.
  - Integrasi input kustom interaktif via Redis state listener: pengguna cukup mengetik angka nominal SOL di chat untuk mengubah default trade size.

### 3. Kemudahan Penggunaan & Navigasi Cepat (Usability & Navigation)
- **Dashboard Command Center (`dashboardHandler.ts`)**:
  - Mengelompokkan status sistem (Mode Paper/Live, Autopilot, Circuit Breaker, Realized PnL harian), saldo dompet (SOL + estimasi IDR), dan jumlah posisi terbuka.
  - Tombol navigasi 2 kolom yang ergonomis di layar ponsel.
- **Manajemen Dompet & Penarikan Terpandu (`walletHandler.ts`)**:
  - Tombol persentase withdrawal menampilkan estimasi SOL real-time: `[25% (~0.125 SOL)]`, `[50% (~0.250 SOL)]`, `[75% (~0.375 SOL)]`, `[100% (MAX)]`.
  - Panduan penarikan memberikan instruksi yang jelas dengan format tap-to-copy jika alamat belum didaftarkan.
- **Pusat Otomasi (`autopilotHandler.ts` & `sniperHandler.ts`)**:
  - Menampilkan ringkasan strategi Trending GeckoTerminal dan New Token Sniper dengan nilai parameter langsung pada tombol kontrol.
  - Log keputusan AI dan statistik kinerja dilengkapi tombol refresh dan kembali yang intuitif.
- **Panduan Terpadu (`helpHandler.ts`) & Laporan Harian (`reportHandler.ts`)**:
  - 3 langkah cepat memulai trading untuk pengguna baru, daftar perintah cepat, dan penjelasan fitur anti-rug.
  - Laporan harian kini mendukung navigasi callback dari Dashboard maupun perintah `/report`.
