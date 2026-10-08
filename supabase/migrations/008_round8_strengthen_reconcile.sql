-- Phase 4: Atomic Financial Finalization
-- Strengthen the reconcile exit function to ensure idempotency and ownership

CREATE OR REPLACE FUNCTION atomic_reconcile_exit(
    p_trade_id UUID,
    p_exit_attempt_id UUID,
    p_status TEXT,
    p_pnl_percent NUMERIC,
    p_pnl_sol NUMERIC,
    p_realized_pnl_sol NUMERIC,
    p_tx_signature TEXT,
    p_remaining_raw NUMERIC,
    p_closed_at TIMESTAMPTZ,
    p_exit_price_usd NUMERIC,
    p_needs_attention BOOLEAN,
    p_token_delta_raw NUMERIC,
    p_sol_delta_lamports NUMERIC,
    p_fee_lamports NUMERIC
) RETURNS TEXT AS $$
DECLARE
    v_trade RECORD;
    v_attempt RECORD;
    v_existing_fill UUID;
BEGIN
    -- 1. Lock the trade row to prevent concurrent modifications
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Trade % not found', p_trade_id;
    END IF;

    -- 2. Validate exit attempt if provided
    IF p_exit_attempt_id IS NOT NULL THEN
        SELECT * INTO v_attempt FROM exit_attempts WHERE id = p_exit_attempt_id FOR UPDATE;
        
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Exit attempt % not found', p_exit_attempt_id;
        END IF;

        IF v_attempt.trade_id != p_trade_id THEN
            RAISE EXCEPTION 'Exit attempt % does not belong to trade %', p_exit_attempt_id, p_trade_id;
        END IF;

        IF v_attempt.status = 'SUCCESS' THEN
            -- Idempotent return if already successfully reconciled
            RETURN 'ALREADY_APPLIED';
        END IF;
    END IF;

    -- 3. Idempotency Check on Fills
    IF p_tx_signature IS NOT NULL THEN
        SELECT id INTO v_existing_fill FROM trade_fills WHERE trade_id = p_trade_id AND tx_signature = p_tx_signature;
        IF FOUND THEN
            -- Attempting to apply a fill that is already applied
            RETURN 'ALREADY_APPLIED';
        END IF;
        
        -- Record the fill
        INSERT INTO trade_fills (trade_id, exit_attempt_id, tx_signature, token_delta_raw, sol_delta_lamports, fee_lamports)
        VALUES (p_trade_id, p_exit_attempt_id, p_tx_signature, p_token_delta_raw, p_sol_delta_lamports, p_fee_lamports);
    END IF;

    -- 4. Prevent negative inventory
    IF p_remaining_raw < 0 THEN
        RAISE EXCEPTION 'Cannot set remaining inventory to negative: %', p_remaining_raw;
    END IF;

    -- 5. Update trade
    UPDATE trades 
    SET 
        status = p_status,
        pnl_percent = p_pnl_percent,
        pnl_sol = p_pnl_sol,
        realized_pnl_sol = p_realized_pnl_sol,
        tx_signature = p_tx_signature,
        remaining_raw = p_remaining_raw,
        closed_at = COALESCE(p_closed_at, closed_at),
        exit_price_usd = COALESCE(p_exit_price_usd, exit_price_usd),
        needs_attention = COALESCE(p_needs_attention, needs_attention),
        updated_at = NOW()
    WHERE id = p_trade_id;

    -- 6. Update exit attempt
    IF p_exit_attempt_id IS NOT NULL THEN
        UPDATE exit_attempts
        SET status = 'SUCCESS', updated_at = NOW()
        WHERE id = p_exit_attempt_id;
    END IF;

    RETURN 'APPLIED';
END;
$$ LANGUAGE plpgsql;
