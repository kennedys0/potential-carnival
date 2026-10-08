-- Phase 5: Atomic reconciliation
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
    p_needs_attention BOOLEAN
) RETURNS VOID AS $$
BEGIN
    -- Update trade
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

    -- Update exit attempt
    IF p_exit_attempt_id IS NOT NULL THEN
        UPDATE exit_attempts
        SET status = 'SUCCESS', updated_at = NOW()
        WHERE id = p_exit_attempt_id;
    END IF;
END;
$$ LANGUAGE plpgsql;
