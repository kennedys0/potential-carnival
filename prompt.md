# ROLE
Kamu adalah Senior Blockchain Engineer & Telegram Bot Developer yang ahli di ekosistem Solana (SPL Token, Token-2022, Raydium, Orca, Meteora, Pump.fun, Jupiter), keamanan token, dan quantitative scalping. Bangun bot Telegram production-grade secara lengkap, bukan prototipe atau pseudo-code.

# TUJUAN
Bot Telegram untuk scalping token di Solana yang:
1. Menyaring token berisiko rug pull/honeypot secara ketat sebelum ditampilkan atau ditradingkan.
2. Memberi analisa AI berbasis data real-time untuk keputusan scalping.
3. Punya sistem wallet (deposit + QR, withdraw) dan eksekusi trade lewat tombol.
4. Tampilan pesan Telegram informatif, rapi, aesthetic, dan mudah dibaca.

# ATURAN WAJIB: NO HARDCODE, NO FAKE DATA
- Dilarang data dummy, mock, angka karangan, atau harga/holder/likuiditas statis di kode produksi.
- Semua nilai berasal dari sumber real-time: RPC Solana, Jupiter API, DexScreener, Birdeye/Helius, RugCheck, dll.
- Semua threshold (min likuiditas, max holder concentration, slippage, TP/SL, dll.) disimpan di file config (.env / config.yaml) dan database, dan bisa diubah user lewat menu Settings di bot.
- Semua secret (bot token, API key, RPC URL, master encryption key) hanya dari environment variable. Sediakan .env.example.
- Jika sebuah API gagal atau data tidak tersedia, tampilkan "N/A" dan turunkan confidence/skor. JANGAN mengisi dengan tebakan.
- Tambahkan mode DRY-RUN/PAPER TRADING (simulasi dengan data harga real, tanpa transaksi asli).

# TECH STACK (boleh diganti jika ada alasan kuat, jelaskan)
- TypeScript + Node.js 20+, grammY (Telegram), @solana/web3.js, @solana/spl-token
- Supabase
- Eksekusi swap: Jupiter API (quote + swap), opsional Jito bundle untuk proteksi MEV
- Data: Helius/RPC (WebSocket + REST), DexScreener, Birdeye, RugCheck API, Jupiter Token API
- AI: abstraksi provider LLM (default Anthropic Claude API) dengan structured JSON output
- Logging terstruktur (pino), error handling, retry + exponential backoff, graceful shutdown
- Docker + docker-compose, struktur modular (modules: scanner, security, analyzer, trader, wallet, telegram-ui)

# MODUL 1: TOKEN SCANNER
- Deteksi token/pool baru dan trending secara real-time (WebSocket/polling: DexScreener, Birdeye, Raydium/Pump.fun/Meteora pool creation).
- Hanya token yang lolos Security Filter (Modul 2) yang boleh masuk ke feed atau diperdagangkan.
- Fitur manual: user paste contract address (CA) lalu bot melakukan full scan dan analisa.

# MODUL 2: ANTI-RUG SECURITY FILTER (inti)
Cek on-chain + data eksternal, semuanya dari data nyata:
**Authority & kontrak**
- Mint authority masih aktif? (harus revoked)
- Freeze authority masih aktif? (harus revoked)
- Token-2022 extensions berbahaya: TransferFee, PermanentDelegate, TransferHook, ConfidentialTransfer, NonTransferable
- Metadata mutable? (flag risiko)
**Likuiditas**
- Total likuiditas USD dan rasio liquidity/market cap
- Status LP: burned / locked (durasi & locker) / unlocked, berapa persen LP dimiliki deployer
- Umur pool dan umur token
**Distribusi holder**
- Top 10 holder % (exclude pool/LP/burn address/program)
- Persentase holding deployer/creator
- Deteksi bundled/sniper wallet: banyak wallet beli di slot/block yang sama dengan pool creation, wallet baru yang didanai dari sumber yang sama
- Jumlah holder unik dan pertumbuhannya
**Honeypot & tradability**
- Simulasi BUY dan SELL lewat Jupiter quote + simulateTransaction, lalu hitung price impact dan efektif tax/fee
- Jika sell gagal atau price impact tidak wajar: BLOCK
**Reputasi deployer**
- Riwayat token yang pernah dibuat deployer wallet, berapa yang rugged/dead (via RugCheck/on-chain history)
**Aktivitas mencurigakan**
- Wash trading (volume tinggi tapi unique trader sedikit), dominasi satu wallet di volume, lonjakan sell dari holder besar
**Sistem skor**
- Hasilkan Safety Score 0–100 dengan bobot per faktor yang dapat dikonfigurasi.
- Hard-block rules (otomatis REJECT, tidak bisa di-override ke BUY otomatis): mint/freeze authority aktif, sell simulation gagal, LP unlocked & dipegang deployer, extension berbahaya.
- Level: 🟢 SAFE / 🟡 CAUTION / 🔴 DANGER, dengan daftar alasan yang spesifik dan transparan (flag apa, nilai berapa, kenapa berisiko).

# MODUL 3: ANALISA AI UNTUK SCALPING
- Kumpulkan snapshot data nyata: OHLCV multi-timeframe (1m/5m/15m dari Birdeye/DexScreener), volume, buy/sell ratio, jumlah transaksi, unique buyer/seller, liquidity depth, price impact per ukuran order, momentum, volatilitas, hasil Security Filter.
- Hitung indikator secara programatik (EMA, RSI, VWAP, ATR, volume spike ratio) dari data candle, bukan oleh LLM.
- Kirim ke LLM dalam format JSON terstruktur. System prompt AI wajib berisi:
  * Hanya boleh memakai data yang diberikan. Dilarang mengarang angka atau fakta.
  * Jika data kurang, nyatakan "data tidak cukup" dan turunkan confidence.
  * Output JSON valid dengan schema: verdict (BUY/WAIT/AVOID), confidence (0-100), setup_type, entry_zone, take_profit_levels, stop_loss, risk_reward, key_reasons[], red_flags[], invalidation_condition, estimated_holding_time.
- Validasi output AI dengan schema (zod). Jika invalid, retry lalu fallback ke "AI unavailable" tanpa crash.
- Level entry/TP/SL dihitung dari ATR dan struktur harga sebenarnya, bukan angka tetap. AI hanya memberi justifikasi dan penyesuaian dalam batas yang dihitung.
- Tampilkan disclaimer bahwa ini bukan nasihat finansial.

# MODUL 4: TRADING ENGINE
- Tombol Buy dengan nominal preset (dari config user) + custom amount; Sell 25/50/100%.
- Slippage dinamis berdasarkan price impact dan likuiditas (batas atas dari setting user).
- Priority fee dinamis dari getRecentPrioritizationFees, opsi Jito tip.
- Auto TP/SL/trailing stop: monitor posisi di background worker, eksekusi otomatis sesuai setting.
- Risk management per user: max posisi bersamaan, max size per trade (% saldo), daily loss limit, cooldown setelah loss beruntun.
- Konfirmasi sebelum eksekusi (dapat dimatikan), idempotency key agar tidak ada double-execution, retry transaksi dengan blockhash baru.
- Catat semua trade (entry, exit, fee, PnL real dari hasil on-chain) ke database.

# MODUL 5: WALLET SYSTEM
- Saat /start, buat wallet Solana baru per user (Keypair).
- Private key WAJIB dienkripsi (AES-256-GCM) dengan master key dari env/KMS, tidak pernah di-log, tidak pernah dikirim ke chat kecuali lewat flow export yang eksplisit (konfirmasi berlapis, pesan auto-delete).
- **Deposit**: tampilkan alamat wallet (monospace, tap-to-copy) + QR code (library qrcode, kirim sebagai foto) + saldo SOL & token real-time dari RPC + tombol Refresh. Deteksi deposit masuk via WebSocket accountSubscribe dan kirim notifikasi.
- **Withdraw**: pilih aset (SOL/SPL), input alamat tujuan (validasi PublicKey, cegah kirim ke alamat sendiri/program yang tidak valid), input jumlah (tombol 25/50/75/MAX, sisakan rent + fee), halaman konfirmasi menampilkan alamat tujuan, jumlah, fee estimasi, lalu tombol Confirm/Cancel. Tampilkan link Solscan setelah sukses.
- Keamanan withdraw: rate limit, opsi whitelist address, PIN/konfirmasi tambahan untuk nominal besar, audit log.
- Halaman Portfolio: saldo, posisi terbuka dengan PnL real-time, riwayat trade.

# MODUL 6: UX/UI TELEGRAM (penting)
- parse_mode HTML. Pakai <b>, <code>, <i>, <a href> secara konsisten. Ratakan kolom dengan monospace bila perlu.
- Pesan harus rapi: header jelas, pemisah visual, emoji semantik (🟢🟡🔴 untuk risiko, 📈📉 untuk tren), progress bar teks untuk skor (contoh: ▰▰▰▰▰▰▱▱▱▱ 62/100), angka diformat (1.2M, $4.5K, 0.0000123 → format subscript/ringkas).
- Contoh template Token Report: nama/simbol/CA (copyable) → harga & perubahan 5m/1h/24h → likuiditas, MC, volume → Safety Score + daftar flag → distribusi holder → analisa AI (verdict, entry, TP, SL, R:R, alasan) → tombol aksi.
- Inline keyboard di setiap layar: [💰 Buy 0.1] [💰 Buy 0.5] [💰 Custom] / [🔄 Refresh] [📊 Chart] [🔍 Solscan] / [🏠 Menu]. Gunakan editMessageText (bukan spam pesan baru), pagination untuk list, dan tombol Back konsisten.
- Menu utama: Scanner, Wallet, Portfolio, Positions, Settings, Help. Command: /start /menu /wallet /scan <CA> /positions /settings.
- Handle callback_query dengan answerCallbackQuery, loading state ("⏳ Menganalisa..."), error message yang ramah dan jelas.
- Bahasa UI: Bahasa Indonesia (siapkan struktur i18n untuk bahasa lain).
- Rate limiting dan anti-flood per user.

# KEAMANAN & KUALITAS
- Validasi semua input user, sanitasi HTML output, lindungi dari callback_data tampering (signed/ID-based).
- Admin-only commands, whitelist user opsional, kill-switch global untuk menghentikan semua trading.
- Test: unit test untuk scoring, filter, kalkulasi, dan formatter; integration test dengan devnet atau mode dry-run.
- Dokumentasi: README (setup, env, deploy), diagram arsitektur singkat, daftar API yang dipakai dan limitnya.

# CARA KERJA & OUTPUT
1. Mulai dengan rencana arsitektur singkat dan struktur folder, lalu tunggu konfirmasi saya jika ada keputusan penting.
2. Implementasikan bertahap per modul dengan kode lengkap yang bisa dijalankan (bukan potongan).
3. Setiap modul: jelaskan sumber data yang dipakai, edge case yang ditangani, dan cara tes.
4. Di akhir berikan: checklist deploy, daftar risiko yang masih tersisa, dan saran peningkatan.

# MODUL 7: AUTOPILOT (AUTO-TRADING)

## Konsep
Mode di mana bot memindai, memfilter, menganalisa, membeli, dan menjual token secara otomatis tanpa konfirmasi manual, sepenuhnya menurut parameter risk & safety yang ditentukan user. Bot TIDAK BOLEH punya parameter bawaan yang dipaksakan. Semua nilai berasal dari konfigurasi user di database (diatur lewat menu Settings → Autopilot di Telegram).

## Pipeline Autopilot (urutan wajib)
Scanner → Security Filter (Modul 2) → AI Analyzer (Modul 3) → Autopilot Rule Check → Risk Manager → Trading Engine (Modul 4) → Position Monitor → Exit → Log & Notifikasi
Setiap token harus lolos SEMUA tahap. Jika satu tahap gagal atau datanya tidak tersedia, token di-SKIP dan alasannya dicatat (bukan ditebak).

## Parameter yang Ditentukan User (semua disimpan per user di DB, bisa diubah via bot, validasi min/max)
**A. Kriteria Safety (entry filter)**
- Min Safety Score, level minimum yang diizinkan (SAFE saja / SAFE+CAUTION)
- Min likuiditas USD, min umur pool, max umur pool (untuk strategi token baru vs matang)
- Max top-10 holder %, max deployer %, max bundled/sniper %
- Min jumlah holder, min unique buyer 5m
- Max price impact & max tax/fee hasil simulasi
- Wajib: LP burned/locked (on/off), mint & freeze authority revoked (selalu ON, tidak bisa dimatikan)

**B. Kriteria Sinyal AI**
- Verdict harus BUY, min confidence AI, min risk:reward
- Min volume spike ratio, min buy/sell ratio, filter momentum
- Pilihan setup yang diizinkan (breakout, pullback, momentum, dll.)

**C. Ukuran & Eksposur**
- Mode sizing: fixed SOL / % saldo / risk-based (ukuran posisi dihitung dari jarak SL agar kerugian per trade = X% saldo)
- Max size per trade, max posisi bersamaan, max total eksposur (% saldo)
- Saldo SOL cadangan minimum untuk fee & rent (tidak boleh disentuh)
- Max trade per jam/hari, cooldown antar trade, cooldown per token

**D. Exit Strategy**
- TP bertingkat (contoh: jual X% di TP1, Y% di TP2, sisanya trailing), SL, trailing stop, time-stop (max holding time)
- Mode exit: berdasarkan ATR (dinamis) atau persentase manual dari user
- Exit darurat otomatis: likuiditas turun drastis, sell-pressure ekstrem, authority berubah, LP ditarik, skor keamanan turun di bawah batas

**E. Circuit Breaker (proteksi akun)**
- Daily loss limit (% atau SOL), max drawdown, max loss beruntun
- Jika tercapai: Autopilot otomatis PAUSE, kirim notifikasi, dan butuh aksi manual user untuk mengaktifkan kembali
- Auto-pause jika RPC/API data error beruntun, data stale, atau saldo di bawah batas

## Preset Profil Risiko (hanya template awal, bukan angka paksaan)
Sediakan tombol profil 🛡️ Konservatif / ⚖️ Moderat / ⚡ Agresif yang mengisi form parameter di atas sebagai TITIK AWAL. Nilai preset dimuat dari file config (bukan hardcode di logic), ditampilkan transparan ke user sebelum dikonfirmasi, dan bebas diedit per parameter. Ada juga opsi "Custom" penuh.

## Aturan Keselamatan Autopilot (tidak bisa di-override)
1. Hard-block Modul 2 selalu berlaku. Autopilot tidak pernah membeli token yang kena hard-block, apa pun setting user.
2. Default saat pertama aktif: PAPER MODE (simulasi dengan data harga real). Live mode butuh aktivasi eksplisit dengan konfirmasi berlapis (ringkasan semua parameter + ketik kata konfirmasi).
3. Kill-switch: tombol 🛑 STOP di setiap notifikasi autopilot dan global kill-switch admin. Menghentikan entry baru seketika. User memilih: tutup semua posisi atau biarkan exit rules berjalan.
4. Idempotency & locking: tidak boleh ada double-buy token yang sama, gunakan lock per user per token (Redis).
5. Re-validasi tepat sebelum eksekusi: ambil quote & jalankan ulang cek honeypot/likuiditas segar. Jika kondisi berubah sejak analisa, batalkan.
6. Data stale guard: jika data lebih tua dari batas yang ditentukan (config), skip trade.
7. Semua keputusan (termasuk SKIP) disimpan di tabel decision_log: timestamp, token, data snapshot, skor, verdict AI, rule mana yang lolos/gagal, alasan. Ini untuk audit & backtest.
8. Autopilot hanya memakai dana wallet user dalam batas yang diset (budget autopilot terpisah, mis. max SOL yang boleh dipakai).

## Arsitektur Teknis
- Worker terpisah (BullMQ) per tahap: scan-worker, evaluate-worker, execute-worker, monitor-worker. Event-driven, bukan satu loop blocking.
- State machine posisi: PENDING → OPEN → PARTIAL_EXIT → CLOSED / FAILED, dengan rekonsiliasi saldo on-chain berkala.
- Recovery saat restart: muat ulang posisi terbuka dari DB + verifikasi on-chain, lanjutkan monitoring tanpa kehilangan state.
- Backtest/replay mode: jalankan rules autopilot terhadap data historis dan decision_log untuk menguji parameter sebelum live. Tampilkan hasil (winrate, avg R, max drawdown, jumlah trade).
- Metrik yang dihitung dari trade nyata (bukan dummy): winrate, profit factor, avg win/loss, expectancy, max drawdown, PnL harian/mingguan.

## UX Telegram untuk Autopilot
- Menu: 🤖 Autopilot → [▶️ Start] [⏸ Pause] [🛑 Stop] / [⚙️ Parameter] [📊 Statistik] [📜 Log Keputusan] / [🏠 Menu]
- Dashboard status (diedit di tempat, bukan spam): status (🟢 Aktif / ⏸ Pause / 🔴 Stop), mode (PAPER/LIVE), profil risiko, budget terpakai vs tersedia, posisi terbuka + PnL, PnL hari ini, sisa batas loss harian, jumlah token discan/lolos/ditolak hari ini.
- Wizard setup bertahap dengan tombol (pilih profil → review parameter → edit per grup A–E → konfirmasi → pilih Paper/Live).
- Notifikasi real-time ber-format rapi untuk: 
  * 🟢 Entry (token, harga, size, safety score, confidence AI, alasan utama, TP/SL, tombol [Lihat Posisi] [Sell Sekarang] [🛑 Stop Autopilot])
  * 💰 Exit (alasan exit, PnL real dalam SOL & %, durasi hold)
  * ⚠️ Alert (circuit breaker aktif, exit darurat, error)
  * 📋 Ringkasan harian otomatis (jumlah trade, winrate, PnL, token terbaik/terburuk)
- Tampilkan "kenapa token ini dibeli" dan "kenapa token ini ditolak" secara transparan di log keputusan.
- Peringatan jelas di setiap aktivasi LIVE bahwa risiko kerugian nyata ada dan hasil masa lalu tidak menjamin hasil di masa depan.

## Testing Wajib untuk Autopilot
- Unit test: evaluasi rule, position sizing, circuit breaker, state machine.
- Simulasi kegagalan: RPC down, tx gagal/timeout, partial fill, data stale, restart di tengah posisi, double-event.
- Soak test di PAPER mode minimal beberapa hari sebelum live; sediakan laporan performa paper.

## Penyesuaian Modul Lain
- Modul 4: fungsi eksekusi harus bisa dipanggil oleh user (manual) maupun autopilot lewat interface yang sama, dengan flag source = MANUAL | AUTOPILOT di log trade.
- Modul 6: tambahkan menu Autopilot dan layar Settings → Autopilot ke menu utama.
- Database: tambahkan tabel autopilot_config, autopilot_state, decision_log, circuit_breaker_events.
- Tambahkan command: /autopilot /pause /stop /stats