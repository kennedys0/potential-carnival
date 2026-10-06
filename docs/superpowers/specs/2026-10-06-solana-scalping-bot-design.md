# Arsitektur & Spesifikasi Desain: Solana Scalping Telegram Bot & Autopilot

**Tanggal:** 2026-10-06  
**Status:** Approved by User  
**Tujuan:** Membangun sistem bot Telegram production-grade untuk scalping dan auto-trading di Solana dengan penyaringan anti-rug ketat, analisa AI berbasis data real-time, manajemen wallet terenkripsi, dan pipeline autopilot berbasis BullMQ.

---

## 1. Prinsip Utama & Aturan Ketat (Strict Invariants)

1. **NO HARDCODE, NO FAKE DATA**:
   - Dilarang keras memakai data dummy, mock, atau angka statis buatan di lingkungan produksi.
   - Semua nilai berasal dari sumber data real-time: RPC Solana (`@solana/web3.js`), Jupiter API, DexScreener, Birdeye, RugCheck API.
   - Jika suatu data atau API tidak tersedia / error, sistem wajib menampilkan `"N/A"`, menurunkan confidence score, dan mencatat alasan secara eksplisit di log audit. Dilarang mengarang nilai.
2. **Konfigurasi Fleksibel & Dinamis**:
   - Semua batas threshold (min liquidity, max holder concentration, slippage, TP/SL, circuit breaker) disimpan di konfigurasi (`default.yaml`), database (Supabase), dan dapat diubah user via menu Settings di bot.
   - Semua rahasia (Bot Token, API Key, RPC URL, Master Encryption Key) WAJIB dimuat dari environment variables (`.env`).
3. **Dukungan Penuh Mode Paper Trading (Dry-Run)**:
   - Mode default untuk semua user baru dan Autopilot adalah PAPER MODE.
   - Paper mode menggunakan data quote real-time dan RPC nyata untuk simulasi eksekusi tanpa menyiarkan transaksi on-chain.
4. **Keamanan Tanpa Kompromi**:
   - Private key wallet selalu dienkripsi dengan **AES-256-GCM**.
   - Hard-block rules pada Anti-Rug Filter tidak bisa di-override oleh strategi apa pun.

---

## 2. Tech Stack

- **Runtime & Language**: Node.js 20+ LTS, TypeScript 5.x
- **Framework Bot**: grammY v1.x (Telegram Bot Framework untuk Node.js)
- **Blockchain SDK**: `@solana/web3.js`, `@solana/spl-token`, `@jup-ag/api`
- **Database**: Supabase (`@supabase/supabase-js`) dengan PostgreSQL relational schema
- **Antrian & Locking**: Redis 7 (Alpine), `bullmq`, `ioredis`
- **AI Engine**: Anthropic Claude API (`@anthropic-ai/sdk`), Zod schema validation
- **Logging & Utilitas**: `pino`, `pino-pretty`, `zod`, `qrcode`, `dotenv`, `yaml`
- **Containerization**: Docker, Docker Compose

---

## 3. Struktur Direktori Proyek

```
solana-scalping/
├── .env.example
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── config/
│   ├── default.yaml
│   └── index.ts
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql
├── src/
│   ├── index.ts
│   ├── config/
│   │   └── env.ts
│   ├── types/
│   │   ├── common.ts
│   │   ├── security.ts
│   │   ├── analysis.ts
│   │   ├── trade.ts
│   │   └── autopilot.ts
│   ├── database/
│   │   ├── client.ts
│   │   └── repositories/
│   │       ├── userRepository.ts
│   │       ├── walletRepository.ts
│   │       ├── tradeRepository.ts
│   │       ├── positionRepository.ts
│   │       ├── autopilotRepository.ts
│   │       └── decisionLogRepository.ts
│   ├── queue/
│   │   ├── connection.ts
│   │   ├── queues.ts
│   │   └── workers/
│   │       ├── scanWorker.ts
│   │       ├── evalWorker.ts
│   │       ├── execWorker.ts
│   │       └── monitorWorker.ts
│   ├── modules/
│   │   ├── scanner/
│   │   │   ├── dexScreenerClient.ts
│   │   │   ├── birdeyeClient.ts
│   │   │   ├── raydiumPoolListener.ts
│   │   │   └── scannerService.ts
│   │   ├── security/
│   │   │   ├── authorityChecker.ts
│   │   │   ├── token2022Inspector.ts
│   │   │   ├── liquidityVerifier.ts
│   │   │   ├── holderAnalyzer.ts
│   │   │   ├── honeypotSimulator.ts
│   │   │   ├── rugCheckClient.ts
│   │   │   ├── scoreCalculator.ts
│   │   │   └── securityFilterService.ts
│   │   ├── analyzer/
│   │   │   ├── indicators/
│   │   │   │   ├── ema.ts
│   │   │   │   ├── rsi.ts
│   │   │   │   ├── vwap.ts
│   │   │   │   ├── atr.ts
│   │   │   │   └── volumeSpike.ts
│   │   │   ├── promptBuilder.ts
│   │   │   ├── llmProvider.ts
│   │   │   └── analyzerService.ts
│   │   ├── trader/
│   │   │   ├── jupiterClient.ts
│   │   │   ├── feeEstimator.ts
│   │   │   ├── orderExecutor.ts
│   │   │   ├── positionManager.ts
│   │   │   └── traderService.ts
│   │   ├── wallet/
│   │   │   ├── encryption.ts
│   │   │   ├── keypairService.ts
│   │   │   ├── balanceWatcher.ts
│   │   │   └── walletService.ts
│   │   ├── telegram/
│   │   │   ├── bot.ts
│   │   │   ├── formatters/
│   │   │   │   ├── messageFormatter.ts
│   │   │   │   └── keyboardBuilder.ts
│   │   │   ├── handlers/
│   │   │   │   ├── startHandler.ts
│   │   │   │   ├── scanHandler.ts
│   │   │   │   ├── walletHandler.ts
│   │   │   │   ├── tradeHandler.ts
│   │   │   │   ├── autopilotHandler.ts
│   │   │   │   └── settingsHandler.ts
│   │   │   └── middlewares/
│   │   │       ├── authMiddleware.ts
│   │   │       └── rateLimitMiddleware.ts
│   │   └── autopilot/
│   │       ├── ruleEvaluator.ts
│   │       ├── riskManager.ts
│   │       ├── circuitBreaker.ts
│   │       ├── autopilotEngine.ts
│   │       └── backtestRunner.ts
│   └── utils/
│       ├── logger.ts
│       ├── solanaConnection.ts
│       └── formatters.ts
└── tests/
    ├── unit/
    └── integration/
```

---

## 4. Skema Database Supabase (SQL DDL)

Skema database tersimpan di `supabase/migrations/001_initial_schema.sql`:

```sql
-- ENUMS
CREATE TYPE user_role AS ENUM ('user', 'admin');
CREATE TYPE trade_side AS ENUM ('BUY', 'SELL');
CREATE TYPE trade_source AS ENUM ('MANUAL', 'AUTOPILOT');
CREATE TYPE position_status AS ENUM ('PENDING', 'OPEN', 'PARTIAL_EXIT', 'CLOSED', 'FAILED');
CREATE TYPE risk_profile_type AS ENUM ('CONSERVATIVE', 'MODERATE', 'AGGRESSIVE', 'CUSTOM');
CREATE TYPE autopilot_action AS ENUM ('BUY', 'SKIP', 'REJECT');

-- USERS
CREATE TABLE users (
    telegram_id BIGINT PRIMARY KEY,
    username TEXT,
    role user_role DEFAULT 'user',
    is_whitelisted BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- USER WALLETS (Encrypted Keypairs)
CREATE TABLE user_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE UNIQUE,
    public_key TEXT NOT NULL UNIQUE,
    encrypted_private_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- USER SETTINGS
CREATE TABLE user_settings (
    user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
    manual_presets NUMERIC[] DEFAULT '{0.1, 0.5, 1.0}',
    default_slippage_bps INT DEFAULT 150,
    priority_level TEXT DEFAULT 'HIGH',
    confirmation_enabled BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- TRADES
CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
    token_mint TEXT NOT NULL,
    token_symbol TEXT NOT NULL,
    side trade_side NOT NULL,
    source trade_source NOT NULL,
    is_dry_run BOOLEAN DEFAULT FALSE,
    sol_amount NUMERIC NOT NULL,
    token_amount NUMERIC NOT NULL,
    entry_price_usd NUMERIC NOT NULL,
    exit_price_usd NUMERIC,
    tx_signature TEXT,
    fee_lamports BIGINT DEFAULT 0,
    pnl_sol NUMERIC,
    pnl_percent NUMERIC,
    status position_status DEFAULT 'OPEN',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);

-- POSITIONS
CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
    trade_id UUID REFERENCES trades(id) ON DELETE CASCADE,
    token_mint TEXT NOT NULL,
    token_symbol TEXT NOT NULL,
    entry_price_usd NUMERIC NOT NULL,
    current_token_amount NUMERIC NOT NULL,
    tp1_price_usd NUMERIC NOT NULL,
    tp1_hit BOOLEAN DEFAULT FALSE,
    tp2_price_usd NUMERIC NOT NULL,
    sl_price_usd NUMERIC NOT NULL,
    trailing_stop_active BOOLEAN DEFAULT FALSE,
    peak_price_usd NUMERIC NOT NULL,
    max_holding_timestamp TIMESTAMPTZ,
    status position_status DEFAULT 'OPEN',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- AUTOPILOT CONFIGS
CREATE TABLE autopilot_configs (
    user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT FALSE,
    mode TEXT DEFAULT 'PAPER', -- 'PAPER' or 'LIVE'
    risk_profile risk_profile_type DEFAULT 'MODERATE',
    safety_params JSONB NOT NULL,
    ai_params JSONB NOT NULL,
    sizing_params JSONB NOT NULL,
    exit_params JSONB NOT NULL,
    circuit_breaker_params JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- AUTOPILOT STATES
CREATE TABLE autopilot_states (
    user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
    is_circuit_broken BOOLEAN DEFAULT FALSE,
    circuit_break_reason TEXT,
    consecutive_losses INT DEFAULT 0,
    daily_realized_pnl_sol NUMERIC DEFAULT 0,
    daily_trades_count INT DEFAULT 0,
    last_trade_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- DECISION LOGS
CREATE TABLE decision_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    action autopilot_action NOT NULL,
    safety_score INT NOT NULL,
    safety_flags JSONB,
    ai_verdict TEXT,
    ai_confidence INT,
    rules_passed JSONB,
    rules_failed JSONB,
    reason_summary TEXT NOT NULL,
    raw_snapshot JSONB,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- CIRCUIT BREAKER EVENTS
CREATE TABLE circuit_breaker_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
    trigger_type TEXT NOT NULL,
    description TEXT NOT NULL,
    triggered_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
```

---

## 5. Rincian Modul 1 s.d. 7

### Modul 1: Token Scanner
- **Listeners**:
  - `RaydiumPoolListener`: Mendengarkan RPC `logsSubscribe` untuk Raydium AMM v4 Program (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`) dan CPMM.
  - `DexScreenerClient` & `BirdeyeClient`: Polling token baru dan trending secara periodik (setiap 15 detik), menyaring token yang sudah pernah discan dalam cache Redis (`seen:tokens`).
- **Trigger Manual**: Menangani input user `/scan <CA>` atau paste Contract Address langsung di chat.
- **Output**: Memasukkan job evaluasi ke BullMQ `evalQueue`.

### Modul 2: Anti-Rug Security Filter Engine
- **Authority & Extensions**:
  - Membaca mint account via `@solana/spl-token`.
  - Jika `mintAuthority !== null` atau `freezeAuthority !== null` ➔ **Hard-Block (Skor = 0)**.
  - Memeriksa extension Token-2022: jika ditemukan `TransferFee`, `PermanentDelegate`, `TransferHook`, `ConfidentialTransfer`, `NonTransferable` ➔ **Hard-Block (Skor = 0)**.
- **Likuiditas & LP**:
  - Verifikasi LP burn via alamat burn (`1111...1111`, dead addresses) atau lock status pada program locker resmi.
  - Jika LP 100% unlocked dan dipegang oleh creator/deployer ➔ **Hard-Block (Skor = 0)**.
  - Likuiditas pool < min liquidity config (misal $5,000) ➔ **Hard-Block**.
- **Distribusi Holder & Sniper Detection**:
  - Mengambil top 20 token accounts via RPC `getTokenLargestAccounts`.
  - Mengabaikan vault program AMM dan burn address untuk menghitung porsi murni Top 10 individual holder.
  - Membaca block awal pembuatan pool untuk mendeteksi transaksi pembelian serentak dari wallet terkait (sniper wallet cluster).
- **Simulasi Honeypot**:
  - Meminta quote beli dan jual ke Jupiter API.
  - Menjalankan `simulateTransaction` di RPC untuk swap SELL token.
  - Jika eksekusi gagal/revert atau slippage tak terduga (hidden tax > 5%) ➔ **Hard-Block**.
- **Perhitungan Skor Dinamis**:
  - Menghitung Safety Score (0–100) berdasarkan bobot konfigurasi.
  - Menandai level: 🟢 SAFE (≥80), 🟡 CAUTION (60–79), 🔴 DANGER (<60).

### Modul 3: AI Scalping Analyzer
- **Kalkulasi Indikator Programatik**:
  - Dihitung dari data candle OHLCV nyata (1m, 5m, 15m) dari DexScreener/Birdeye.
  - Indikator: EMA(9), EMA(21), RSI(14), VWAP, ATR(14), Volume Spike Ratio.
  - Menghitung level Stop Loss ($Entry - 1.5 \times ATR$) dan Take Profit ($1.5R$ dan $3R$) secara programatik.
- **Abstraksi LLM (`ILlmProvider`)**:
  - Default Anthropic Claude 3.5 Sonnet / Haiku.
  - System prompt mewajibkan analisis hanya berdasarkan data input JSON, tanpa menambah angka karangan.
  - Zod validation schema untuk memverifikasi struktur output JSON: `verdict`, `confidence`, `setup_type`, `entry_zone`, `take_profit_levels`, `stop_loss_usd`, `risk_reward_ratio`, `key_reasons`, `red_flags`.
  - Fallback: Jika LLM gagal atau timeout 5 detik, bot mengembalikan `AI_UNAVAILABLE` tanpa crash.

### Modul 4: Trading Engine
- **Integrasi Jupiter**:
  - Pengambilan quote dan pembuatan transaksi swap serial via `@jup-ag/api`.
  - Slippage dinamis: `base_slippage + (price_impact * 1.2)`, dibatasi oleh preferensi user.
  - Priority fee dinamis: Membaca persentil ke-75 dari `getRecentPrioritizationFees` on-chain.
- **Idempotency & Concurrency**:
  - Redis lock `lock:trade:{userId}:{tokenMint}` selama eksekusi.
  - Idempotency key per swap agar tidak terjadi double-transaction pada network retry.
- **Dry-Run & Real Execution**:
  - Dry-run: Mensimulasikan trade menggunakan data harga aktual, fee estimasi, dan mencatatnya ke DB dengan flag `is_dry_run = true`.
  - Real: Menandatangani transaksi dengan private key terenkripsi dan menyiarkannya ke RPC.
- **Position Monitoring**:
  - Memantau posisi terbuka untuk mengeksekusi TP bertingkat (TP1 50%, TP2 sisa), Trailing Stop, dan Emergency Exit jika likuiditas ditarik drastis.

### Modul 5: Secure Wallet System
- **Kriptografi**:
  - Enkripsi AES-256-GCM menggunakan `MASTER_ENCRYPTION_KEY` (32 bytes).
  - Menyimpan ciphertext, IV (12 bytes), dan authTag (16 bytes) di Supabase.
  - Private key plaintext segera dibersihkan dari memori setelah digunakan.
- **Deposit**:
  - Menampilkan public key monospace dan gambar QR Code PNG yang di-generate via library `qrcode`.
  - Membuka WebSocket listener RPC (`accountSubscribe`) untuk mendeteksi transfer masuk secara real-time dan mengirim notifikasi ke user.
- **Withdraw**:
  - Validasi ketat format `PublicKey`.
  - Memastikan saldo yang disisakan cukup untuk rent-exempt dan biaya transaksi (0.005 SOL).
  - Konfirmasi ringkasan tujuan dan jumlah sebelum broadcast transaksi.
  - Memberikan link Solscan setelah transaksi sukses.

### Modul 6: Telegram UI / UX
- **Format HTML Konsisten**:
  - `parse_mode: 'HTML'`, formatting rapi, tag `<code>` untuk token mint dan PublicKey.
  - Progress bar teks: `▰▰▰▰▰▰▱▱▱▱ 60/100`.
- **In-Place Updates**:
  - Menghindari spam pesan dengan `editMessageText` dan `answerCallbackQuery`.
  - Tombol menu interaktif: [💰 Buy 0.1] [💰 Buy 0.5] [💰 Custom] / [🔄 Refresh] [📊 Chart] [🔍 Solscan] / [🏠 Menu].
  - Rate limiting middleware per user untuk mencegah flooding command.

### Modul 7: Autopilot Engine
- **Pipeline Eksekusi**:
  1. Token terdeteksi oleh Scanner.
  2. Evaluasi Anti-Rug Filter: Jika hard-block atau skor < threshold ➔ REJECT / SKIP (catat ke `decision_logs`).
  3. Evaluasi AI Scalping: Verdict harus BUY, confidence ≥ min threshold, setup diizinkan.
  4. Autopilot Rule Check: Memeriksa parameter user (likuiditas, holder %, umur pool).
  5. Risk Manager: Memeriksa batas posisi bersamaan, saldo cadangan, max drawdown harian.
  6. Re-validasi Sebelum Eksekusi: Ambil ulang quote segar dan verifikasi likuiditas detik itu juga.
  7. Eksekusi via Trading Engine dengan Redis distributed lock.
  8. Pendaftaran posisi ke `monitorQueue` untuk trailing stop / TP / SL.
  9. Notifikasi hasil eksekusi ke Telegram user.
- **Circuit Breaker**:
  - Otomatis PAUSE jika rugi harian melampaui `daily_loss_limit` atau terjadi kerugian beruntun (misal 3x).
  - Otomatis PAUSE jika RPC/API error berturut-turut atau data terdeteksi stale (> 30 detik).
- **Preset Risiko di `default.yaml`**:
  - 🛡️ Konservatif: Safety Score ≥ 85, Min Liquidity $25K, Sizing 0.1 SOL, SL 5%, TP 15%.
  - ⚖️ Moderat: Safety Score ≥ 75, Min Liquidity $10K, Sizing 0.25 SOL, SL 8%, TP 25%.
  - ⚡ Agresif: Safety Score ≥ 65, Min Liquidity $5K, Sizing 0.5 SOL, SL 12%, TP 40%.
  - 🛠️ Custom: Pengaturan bebas per parameter di database.

---

## 6. Strategi Pengujian (Testing Strategy)

- **Unit Tests**:
  - Perhitungan indikator teknis (EMA, RSI, ATR, VWAP, Volume Spike).
  - Algoritma scoring Anti-Rug Filter dan Hard-block rules.
  - Enkripsi dan dekripsi AES-256-GCM.
  - Evaluasi Circuit Breaker dan State Machine posisi.
- **Integration Tests**:
  - Simulasi order Paper Trading end-to-end.
  - Parser DexScreener, Birdeye, dan RugCheck dengan respon nyata / rekaman fixture.
  - Simulasi kegagalan network, retry backoff, dan recovery state posisi setelah restart.

---

## 7. Rencana Deployment & Operasional

- **Docker Compose**:
  - Layanan Redis 7 Alpine dengan persistent volume.
  - Layanan Bot Node.js 20 dengan konfigurasi restart policy `unless-stopped`.
- **Environment Requirements**:
  - `TELEGRAM_BOT_TOKEN`, `SOLANA_RPC_URL`, `SOLANA_WSS_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MASTER_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `REDIS_URL`.
