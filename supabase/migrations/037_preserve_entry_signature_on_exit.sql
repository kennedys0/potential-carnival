-- Forward-only correction: trades.tx_signature is the immutable entry
-- signature. Exit signatures live in exit_attempts and trade_fills only.
-- Repair only finalized position rows with durable entry evidence. Pending
-- transactions are deliberately excluded so an unconfirmed signature is not
-- promoted into the confirmed entry ledger.
UPDATE public.trades
   SET tx_signature = pending_signature,
       updated_at = NOW()
 WHERE is_dry_run = FALSE
   AND status IN ('OPEN', 'PARTIAL_EXIT', 'CLOSED')
   AND pending_signature IS NOT NULL
   AND tx_signature IS DISTINCT FROM pending_signature;

CREATE OR REPLACE FUNCTION public.atomic_reconcile_exit(
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
    v_existing_fill RECORD;
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
    SELECT * INTO v_trade
      FROM public.trades
     WHERE id = p_trade_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'INVALID_STATE';
    END IF;

    IF v_trade.is_dry_run = FALSE THEN
        IF p_exit_attempt_id IS NULL OR p_tx_signature IS NULL THEN
            RETURN 'INVALID_EVIDENCE';
        END IF;
    END IF;

    IF p_exit_attempt_id IS NOT NULL THEN
        SELECT * INTO v_attempt
          FROM public.exit_attempts
         WHERE id = p_exit_attempt_id
         FOR UPDATE;
        IF NOT FOUND THEN
            RETURN 'INVALID_STATE';
        END IF;
        IF v_attempt.trade_id != p_trade_id THEN
            RETURN 'CONFLICT';
        END IF;
        IF v_attempt.status = 'FAILED' THEN
            RETURN 'INVALID_STATE';
        END IF;
        IF v_attempt.tx_signature IS NOT NULL
           AND p_tx_signature IS NOT NULL
           AND v_attempt.tx_signature != p_tx_signature THEN
            RETURN 'INVALID_EVIDENCE';
        END IF;
    END IF;

    IF p_token_delta_raw <= 0 OR p_sol_delta_lamports < 0 OR p_fee_lamports < 0 THEN
        RETURN 'INVALID_EVIDENCE';
    END IF;

    IF p_tx_signature IS NOT NULL THEN
        SELECT * INTO v_existing_fill
          FROM public.trade_fills
         WHERE trade_id = p_trade_id
           AND tx_signature = p_tx_signature;
        IF FOUND THEN
            IF v_existing_fill.token_delta_raw != p_token_delta_raw
               OR v_existing_fill.sol_delta_lamports != p_sol_delta_lamports
               OR v_existing_fill.fee_lamports != p_fee_lamports
               OR v_existing_fill.exit_attempt_id IS DISTINCT FROM p_exit_attempt_id THEN
                RETURN 'CONFLICT';
            END IF;
            RETURN 'ALREADY_APPLIED';
        END IF;
    END IF;

    IF p_exit_attempt_id IS NOT NULL AND v_attempt.status = 'SUCCESS' THEN
        RETURN 'INVALID_STATE';
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

    IF p_tx_signature IS NOT NULL THEN
        INSERT INTO public.trade_fills (
            trade_id,
            exit_attempt_id,
            tx_signature,
            token_delta_raw,
            sol_delta_lamports,
            fee_lamports,
            realized_pnl_sol
        ) VALUES (
            p_trade_id,
            p_exit_attempt_id,
            p_tx_signature,
            p_token_delta_raw,
            p_sol_delta_lamports,
            p_fee_lamports,
            COALESCE(v_realized_pnl_sol, 0)
        );
    END IF;

    UPDATE public.trades
       SET status = v_new_status::public.position_status,
           pnl_percent = v_pnl_percent,
           pnl_sol = v_new_realized_pnl,
           realized_pnl_sol = v_new_realized_pnl,
           remaining_raw = v_new_remaining_raw,
           closed_at = v_closed_at,
           exit_price_usd = COALESCE(p_exit_price_usd, trades.exit_price_usd),
           updated_at = NOW()
     WHERE id = p_trade_id;

    IF p_exit_attempt_id IS NOT NULL THEN
        UPDATE public.exit_attempts
           SET status = 'SUCCESS',
               tx_signature = COALESCE(p_tx_signature, exit_attempts.tx_signature),
               updated_at = NOW()
         WHERE id = p_exit_attempt_id;
    END IF;

    RETURN 'APPLIED';
END;
$$ LANGUAGE plpgsql SET search_path = public;

COMMENT ON FUNCTION public.atomic_reconcile_exit(
    UUID,UUID,TEXT,NUMERIC,NUMERIC,NUMERIC,NUMERIC
) IS 'Atomically applies an exit fill without overwriting trades.tx_signature (the entry signature).';

REVOKE ALL ON FUNCTION public.atomic_reconcile_exit(
    UUID,UUID,TEXT,NUMERIC,NUMERIC,NUMERIC,NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_reconcile_exit(
    UUID,UUID,TEXT,NUMERIC,NUMERIC,NUMERIC,NUMERIC
) TO service_role;
