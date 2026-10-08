-- Phase 8: Withdrawal Ledger
-- Creates an immutable ledger for withdrawal requests to prevent double-execution.

CREATE TABLE IF NOT EXISTS withdrawal_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    amount_sol NUMERIC NOT NULL,
    destination_address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMING', 'SUCCESS', 'FAILED')),
    tx_signature TEXT,
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure a single idempotency key can only be submitted once
CREATE UNIQUE INDEX IF NOT EXISTS unique_withdrawal_idempotency ON withdrawal_attempts (idempotency_key);

-- Ensure a user only has one pending withdrawal at a time
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_withdrawal ON withdrawal_attempts (user_id) WHERE status = 'PENDING';
