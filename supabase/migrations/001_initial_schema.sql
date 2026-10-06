-- Supabase / PostgreSQL Schema for Solana Scalping & Autopilot Bot

-- 1. ENUMS
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('user', 'admin');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE trade_side AS ENUM ('BUY', 'SELL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE trade_source AS ENUM ('MANUAL', 'AUTOPILOT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE position_status AS ENUM ('PENDING', 'OPEN', 'PARTIAL_EXIT', 'CLOSED', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE risk_profile_type AS ENUM ('CONSERVATIVE', 'MODERATE', 'AGGRESSIVE', 'CUSTOM');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE autopilot_action AS ENUM ('BUY', 'SKIP', 'REJECT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. USERS
CREATE TABLE IF NOT EXISTS users (
    telegram_id BIGINT PRIMARY KEY,
    username TEXT,
    role user_role DEFAULT 'user',
    is_whitelisted BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. USER WALLETS (AES-256-GCM Encrypted)
CREATE TABLE IF NOT EXISTS user_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE UNIQUE,
    public_key TEXT NOT NULL UNIQUE,
    encrypted_private_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. USER SETTINGS
CREATE TABLE IF NOT EXISTS user_settings (
    user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
    manual_presets NUMERIC[] DEFAULT '{0.1, 0.5, 1.0}',
    default_slippage_bps INT DEFAULT 150,
    priority_level TEXT DEFAULT 'HIGH',
    confirmation_enabled BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. TRADES
CREATE TABLE IF NOT EXISTS trades (
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

-- 6. POSITIONS
CREATE TABLE IF NOT EXISTS positions (
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

-- 7. AUTOPILOT CONFIGS
CREATE TABLE IF NOT EXISTS autopilot_configs (
    user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT FALSE,
    mode TEXT DEFAULT 'PAPER',
    risk_profile risk_profile_type DEFAULT 'MODERATE',
    safety_params JSONB NOT NULL,
    ai_params JSONB NOT NULL,
    sizing_params JSONB NOT NULL,
    exit_params JSONB NOT NULL,
    circuit_breaker_params JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. AUTOPILOT STATES
CREATE TABLE IF NOT EXISTS autopilot_states (
    user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
    is_circuit_broken BOOLEAN DEFAULT FALSE,
    circuit_break_reason TEXT,
    consecutive_losses INT DEFAULT 0,
    daily_realized_pnl_sol NUMERIC DEFAULT 0,
    daily_trades_count INT DEFAULT 0,
    last_trade_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. DECISION LOGS
CREATE TABLE IF NOT EXISTS decision_logs (
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

-- 10. CIRCUIT BREAKER EVENTS
CREATE TABLE IF NOT EXISTS circuit_breaker_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
    trigger_type TEXT NOT NULL,
    description TEXT NOT NULL,
    triggered_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
