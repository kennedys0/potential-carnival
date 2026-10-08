-- Phase 9: Fill Ledger
-- Creates an immutable ledger for fills to guarantee idempotency.

CREATE TABLE IF NOT EXISTS trade_fills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    exit_attempt_id UUID REFERENCES exit_attempts(id) ON DELETE SET NULL,
    tx_signature TEXT NOT NULL,
    token_delta_raw NUMERIC NOT NULL,
    sol_delta_lamports NUMERIC NOT NULL,
    fee_lamports NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure a transaction signature can only be recorded once per trade
CREATE UNIQUE INDEX IF NOT EXISTS unique_trade_fill_tx ON trade_fills (trade_id, tx_signature);
