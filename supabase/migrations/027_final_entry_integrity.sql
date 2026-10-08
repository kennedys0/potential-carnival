-- Forward-only override for databases that already applied the unsafe 025 migration.
-- Security boundary: a successful live BUY may be finalized ONLY from verified,
-- previously persisted signature evidence and an exact, nonnegative fill.
-- This function is a database consistency gate, NOT an independent on-chain verifier.
CREATE OR REPLACE FUNCTION atomic_reconcile_entry(
    p_trade_id UUID,
    p_status TEXT,
    p_tx_signature TEXT,
    p_remaining_raw NUMERIC,
    p_token_decimals INTEGER,
    p_sol_spent_lamports NUMERIC,
    p_token_amount_raw NUMERIC,
    p_fee_lamports NUMERIC,
    p_sol_amount NUMERIC,
    p_token_amount NUMERIC,
    p_needs_attention BOOLEAN
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_trade trades%ROWTYPE;
    v_existing_fill trade_fills%ROWTYPE;
BEGIN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'INVALID_STATE';
    END IF;

    -- Deliberately do not allow arbitrary OPEN, FAILED, or CLOSED transitions
    -- through an RPC that is meant solely to apply verified BUY fills.
    IF p_status IS DISTINCT FROM 'OPEN' OR v_trade.is_dry_run IS DISTINCT FROM FALSE
        OR v_trade.side IS DISTINCT FROM 'BUY' THEN
        RETURN 'INVALID_STATE';
    END IF;

    IF p_tx_signature IS NULL OR btrim(p_tx_signature) = ''
        OR p_token_amount_raw IS NULL OR p_token_amount_raw <= 0
        OR p_remaining_raw IS NULL OR p_remaining_raw <> p_token_amount_raw
        OR p_token_amount_raw <> trunc(p_token_amount_raw)
        OR p_token_decimals IS NULL OR p_token_decimals NOT BETWEEN 0 AND 18
        OR p_sol_spent_lamports IS NULL OR p_sol_spent_lamports <= 0
        OR p_sol_spent_lamports <> trunc(p_sol_spent_lamports)
        OR p_sol_spent_lamports > 9223372036854775807::NUMERIC
        OR p_fee_lamports IS NULL OR p_fee_lamports < 0
        OR p_fee_lamports <> trunc(p_fee_lamports)
        OR p_fee_lamports > 9223372036854775807::NUMERIC THEN
        RETURN 'INVALID_EVIDENCE';
    END IF;

    -- Signed transaction identity must have been durably stored before broadcast.
    IF v_trade.pending_signature IS DISTINCT FROM p_tx_signature THEN
        RETURN 'INVALID_EVIDENCE';
    END IF;
    IF v_trade.tx_signature IS NOT NULL AND v_trade.tx_signature <> p_tx_signature THEN
        RETURN 'CONFLICT';
    END IF;

    -- True idempotency: match the complete ledger payload, not just its signature.
    SELECT * INTO v_existing_fill
    FROM trade_fills
    WHERE trade_id = p_trade_id AND tx_signature = p_tx_signature;
    IF FOUND THEN
        IF v_existing_fill.exit_attempt_id IS NOT NULL
            OR v_existing_fill.token_delta_raw IS DISTINCT FROM p_token_amount_raw
            OR v_existing_fill.sol_delta_lamports IS DISTINCT FROM p_sol_spent_lamports
            OR v_existing_fill.fee_lamports IS DISTINCT FROM p_fee_lamports
            OR v_trade.status NOT IN ('OPEN', 'PARTIAL_EXIT', 'CLOSED') THEN
            RETURN 'CONFLICT';
        END IF;
        RETURN 'ALREADY_APPLIED';
    END IF;

    IF v_trade.status NOT IN ('SIGNED', 'BROADCAST_ATTEMPTED', 'PENDING') THEN
        RETURN 'INVALID_STATE';
    END IF;

    -- The fill, quantity, and new position state are committed in one DB transaction.
    INSERT INTO trade_fills
        (trade_id, exit_attempt_id, tx_signature, token_delta_raw, sol_delta_lamports, fee_lamports)
    VALUES
        (p_trade_id, NULL, p_tx_signature, p_token_amount_raw, p_sol_spent_lamports, p_fee_lamports);

    UPDATE trades SET
        status = 'OPEN'::position_status,
        tx_signature = p_tx_signature,
        remaining_raw = p_remaining_raw,
        token_amount_raw = p_token_amount_raw,
        token_decimals = p_token_decimals,
        sol_spent_lamports = p_sol_spent_lamports::BIGINT,
        fee_lamports = p_fee_lamports::BIGINT,
        sol_amount = p_sol_spent_lamports / 1000000000::NUMERIC,
        token_amount = p_token_amount_raw / power(10::NUMERIC, p_token_decimals),
        needs_attention = COALESCE(p_needs_attention, needs_attention)
    WHERE id = p_trade_id;

    RETURN 'APPLIED';
END;
$$;

-- Financial RPCs are used by the server's Supabase service-role client only.
-- Role existence is checked so an isolated vanilla PostgreSQL test DB also works.
REVOKE ALL ON FUNCTION atomic_reconcile_entry(UUID,TEXT,TEXT,NUMERIC,INTEGER,NUMERIC,NUMERIC,NUMERIC,NUMERIC,NUMERIC,BOOLEAN) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION atomic_reconcile_entry(UUID,TEXT,TEXT,NUMERIC,INTEGER,NUMERIC,NUMERIC,NUMERIC,NUMERIC,NUMERIC,BOOLEAN) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION atomic_reconcile_entry(UUID,TEXT,TEXT,NUMERIC,INTEGER,NUMERIC,NUMERIC,NUMERIC,NUMERIC,NUMERIC,BOOLEAN) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION atomic_reconcile_entry(UUID,TEXT,TEXT,NUMERIC,INTEGER,NUMERIC,NUMERIC,NUMERIC,NUMERIC,NUMERIC,BOOLEAN) TO service_role';
  END IF;
END;
$$;
