-- Phase 13: Entry Reconciliation Atomicity
-- Ensures that entry reconciliations are atomic and idempotent, just like exits.

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
) RETURNS TEXT AS $$
DECLARE
    v_trade RECORD;
    v_existing_fill UUID;
BEGIN
    -- 1. Lock the trade row
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Trade % not found', p_trade_id;
    END IF;

    IF v_trade.status != 'PENDING' THEN
        -- It might have already been resolved (idempotent skip)
        RETURN 'ALREADY_RESOLVED';
    END IF;

    -- 2. Idempotency Check on Fills (if opening with a successful tx)
    IF p_status = 'OPEN' AND p_tx_signature IS NOT NULL THEN
        SELECT id INTO v_existing_fill FROM trade_fills WHERE trade_id = p_trade_id AND tx_signature = p_tx_signature;
        IF FOUND THEN
            RETURN 'ALREADY_APPLIED';
        END IF;
        
        -- Record the fill for entry (using negative token delta or just keeping it raw, usually positive for entry)
        INSERT INTO trade_fills (trade_id, exit_attempt_id, tx_signature, token_delta_raw, sol_delta_lamports, fee_lamports)
        VALUES (p_trade_id, NULL, p_tx_signature, p_token_amount_raw, p_sol_spent_lamports, p_fee_lamports);
    END IF;

    -- 3. Update trade
    UPDATE trades 
    SET 
        status = COALESCE(p_status, status),
        tx_signature = COALESCE(p_tx_signature, tx_signature),
        remaining_raw = COALESCE(p_remaining_raw, remaining_raw),
        token_decimals = COALESCE(p_token_decimals, token_decimals),
        sol_spent_lamports = COALESCE(p_sol_spent_lamports::TEXT, sol_spent_lamports),
        token_amount_raw = COALESCE(p_token_amount_raw::TEXT, token_amount_raw),
        fee_lamports = COALESCE(p_fee_lamports, fee_lamports),
        sol_amount = COALESCE(p_sol_amount, sol_amount),
        token_amount = COALESCE(p_token_amount, token_amount),
        needs_attention = COALESCE(p_needs_attention, needs_attention),
        updated_at = NOW()
    WHERE id = p_trade_id;

    RETURN 'APPLIED';
END;
$$ LANGUAGE plpgsql;
