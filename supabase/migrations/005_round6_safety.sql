-- Migration Phase 1.1: Exit Attempts Lifecycle & Lock
CREATE TABLE IF NOT EXISTS exit_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id UUID REFERENCES trades(id) ON DELETE CASCADE,
    percentage NUMERIC NOT NULL,
    tokens_amount_raw NUMERIC NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    tx_signature TEXT,
    idempotency_key TEXT UNIQUE NOT NULL,
    worker_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add lock fields to trades table to prevent concurrent exits
ALTER TABLE trades ADD COLUMN IF NOT EXISTS locked_for_exit_at TIMESTAMPTZ;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS locked_for_exit_by TEXT;
