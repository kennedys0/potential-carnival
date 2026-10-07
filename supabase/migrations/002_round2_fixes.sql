-- Phase 1
ALTER TABLE autopilot_states ADD COLUMN IF NOT EXISTS max_drawdown NUMERIC DEFAULT 0;

-- Phase 2
ALTER TABLE trades ADD COLUMN IF NOT EXISTS token_amount_raw NUMERIC;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS token_decimals INT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS sol_spent_lamports BIGINT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS sol_received_lamports BIGINT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS sol_usd_at_fill NUMERIC;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;

-- Phase 3
ALTER TABLE positions ADD COLUMN IF NOT EXISTS tp1_pct_to_sell NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS tp2_pct_to_sell NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS trailing_pct NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS emergency_exit_config JSONB;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS source trade_source;

-- Withdrawals (Phase 7)
CREATE TABLE IF NOT EXISTS withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
    asset TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    tx_signature TEXT,
    status TEXT DEFAULT 'PENDING',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS owner_pubkey TEXT;
