-- Migration 028: Dual Autopilot & New Token Sniper

DO $$ BEGIN
    CREATE TYPE trading_strategy AS ENUM ('TRENDING', 'NEW_TOKEN_SNIPER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy trading_strategy DEFAULT 'TRENDING';
ALTER TABLE decision_logs ADD COLUMN IF NOT EXISTS strategy trading_strategy DEFAULT 'TRENDING';

CREATE TABLE IF NOT EXISTS sniper_configs (
    user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
    enabled BOOLEAN DEFAULT FALSE,
    trading_mode TEXT DEFAULT 'PAPER',
    buy_amount_sol NUMERIC DEFAULT 0.01,
    max_active_positions INT DEFAULT 3,
    max_buys_per_day INT DEFAULT 3,
    max_daily_entry_budget_sol NUMERIC DEFAULT 0.03,
    max_pool_age_minutes INT DEFAULT 5,
    min_pool_age_seconds INT DEFAULT 20,
    min_liquidity_usd NUMERIC DEFAULT 10000,
    minimum_safety_score INT DEFAULT 80,
    require_sell_route BOOLEAN DEFAULT TRUE,
    reject_unknown_critical_safety_checks BOOLEAN DEFAULT TRUE,
    max_slippage_bps INT DEFAULT 300,
    tp_sl_enabled BOOLEAN DEFAULT TRUE,
    take_profit_percent NUMERIC DEFAULT 20,
    stop_loss_percent NUMERIC DEFAULT 10,
    notifications_enabled BOOLEAN DEFAULT TRUE,
    rejected_candidates_summary BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sniper_states (
    user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
    daily_buys_count INT DEFAULT 0,
    daily_entry_sol NUMERIC DEFAULT 0,
    accounting_date DATE DEFAULT CURRENT_DATE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
