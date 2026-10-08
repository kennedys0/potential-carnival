-- Phase 1: Atomic SQL validation and verified fill ledger
CREATE OR REPLACE FUNCTION atomic_reconcile_exit(
    p_trade_id UUID,
    p_exit_attempt_id UUID,
    p_tx_signature TEXT,
    p_token_delta_raw NUMERIC,
    p_sol_delta_lamports NUMERIC,
    p_fee_lamports NUMERIC,
    p_exit_price_usd NUMERIC
) RETURNS TEXT AS $$
DECLARE
    v_trade RECORD;
    v_attempt RECORD;
    v_existing_fill UUID;
    v_new_remaining_raw NUMERIC;
    v_cost_lamports NUMERIC;
    v_cost_sol NUMERIC;
    v_sol_received NUMERIC;
    v_fee_sol NUMERIC;
    v_realized_pnl_sol NUMERIC;
    v_pnl_percent NUMERIC;
    v_new_status TEXT;
    v_new_realized_pnl NUMERIC;
    v_closed_at TIMESTAMPTZ;
BEGIN
    -- Lock trade
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'INVALID_STATE';
    END IF;
    
    -- Check if attempt exists and lock
    IF p_exit_attempt_id IS NOT NULL THEN
        SELECT * INTO v_attempt FROM exit_attempts WHERE id = p_exit_attempt_id FOR UPDATE;
        IF NOT FOUND THEN
            RETURN 'INVALID_STATE';
        END IF;
        IF v_attempt.trade_id != p_trade_id THEN
            RETURN 'CONFLICT';
        END IF;
        IF v_attempt.status = 'SUCCESS' THEN
            RETURN 'ALREADY_APPLIED';
        END IF;
    END IF;

    -- Check if fill exists
    IF p_tx_signature IS NOT NULL THEN
        SELECT id INTO v_existing_fill FROM trade_fills WHERE trade_id = p_trade_id AND tx_signature = p_tx_signature;
        IF FOUND THEN
            RETURN 'ALREADY_APPLIED';
        END IF;
    END IF;

    -- Inventory check
    IF p_token_delta_raw <= 0 THEN
        RETURN 'INVALID_EVIDENCE';
    END IF;

    IF v_trade.remaining_raw < p_token_delta_raw THEN
        RETURN 'INSUFFICIENT_INVENTORY';
    END IF;

    v_new_remaining_raw := v_trade.remaining_raw - p_token_delta_raw;
    IF v_new_remaining_raw <= 0 THEN
        v_new_status := 'CLOSED';
        v_closed_at := NOW();
    ELSE
        v_new_status := 'PARTIAL_EXIT';
        v_closed_at := v_trade.closed_at;
    END IF;

    -- Calculate PnL
    IF v_trade.sol_spent_lamports IS NOT NULL AND v_trade.token_amount_raw > 0 THEN
        v_cost_lamports := (v_trade.sol_spent_lamports * p_token_delta_raw) / v_trade.token_amount_raw;
        v_cost_sol := v_cost_lamports / 1000000000.0;
        v_sol_received := p_sol_delta_lamports / 1000000000.0;
        v_fee_sol := p_fee_lamports / 1000000000.0;
        
        v_realized_pnl_sol := v_sol_received - v_cost_sol - v_fee_sol;
        v_new_realized_pnl := COALESCE(v_trade.realized_pnl_sol, 0) + v_realized_pnl_sol;
        
        IF v_cost_sol > 0 THEN
            v_pnl_percent := ((v_sol_received - v_cost_sol) / v_cost_sol) * 100;
        ELSE
            v_pnl_percent := COALESCE(v_trade.pnl_percent, 0);
        END IF;
    ELSE
        v_new_realized_pnl := COALESCE(v_trade.realized_pnl_sol, 0);
        v_pnl_percent := COALESCE(v_trade.pnl_percent, 0);
    END IF;

    -- Record fill
    IF p_tx_signature IS NOT NULL THEN
        INSERT INTO trade_fills (trade_id, exit_attempt_id, tx_signature, token_delta_raw, sol_delta_lamports, fee_lamports)
        VALUES (p_trade_id, p_exit_attempt_id, p_tx_signature, p_token_delta_raw, p_sol_delta_lamports, p_fee_lamports);
    END IF;

    -- Update trade
    UPDATE trades 
    SET 
        status = v_new_status,
        pnl_percent = v_pnl_percent,
        pnl_sol = v_new_realized_pnl,
        realized_pnl_sol = v_new_realized_pnl,
        tx_signature = p_tx_signature,
        remaining_raw = v_new_remaining_raw,
        closed_at = v_closed_at,
        exit_price_usd = COALESCE(p_exit_price_usd, v_trade.exit_price_usd),
        updated_at = NOW()
    WHERE id = p_trade_id;

    -- Update attempt
    IF p_exit_attempt_id IS NOT NULL THEN
        UPDATE exit_attempts
        SET status = 'SUCCESS', updated_at = NOW()
        WHERE id = p_exit_attempt_id;
    END IF;

    RETURN 'APPLIED';
END;
$$ LANGUAGE plpgsql;
