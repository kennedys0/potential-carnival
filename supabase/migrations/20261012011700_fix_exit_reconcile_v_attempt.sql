-- Fix: ensure v_attempt record is never evaluated when p_exit_attempt_id IS NULL (e.g. paper trading exits)
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
    v_prior_sold_raw NUMERIC;
    v_cumulative_sold_raw NUMERIC;
    v_cost_before_lamports NUMERIC;
    v_cost_after_lamports NUMERIC;
    v_cost_lamports NUMERIC;
    v_entry_fee_before_lamports NUMERIC;
    v_entry_fee_after_lamports NUMERIC;
    v_entry_fee_share_lamports NUMERIC;
    v_basis_sol NUMERIC;
    v_sol_received NUMERIC;
    v_exit_fee_sol NUMERIC;
    v_realized_pnl_sol NUMERIC;
    v_pnl_percent NUMERIC;
    v_new_status TEXT;
    v_new_realized_pnl NUMERIC;
    v_closed_at TIMESTAMPTZ;
BEGIN
    SELECT *
      INTO v_trade
      FROM public.trades
     WHERE id = p_trade_id
     FOR UPDATE;
    IF NOT FOUND THEN RETURN 'INVALID_STATE'; END IF;

    IF v_trade.is_dry_run = FALSE
       AND (p_exit_attempt_id IS NULL OR p_tx_signature IS NULL) THEN
        RETURN 'INVALID_EVIDENCE';
    END IF;

    IF p_exit_attempt_id IS NOT NULL THEN
        SELECT *
          INTO v_attempt
          FROM public.exit_attempts
         WHERE id = p_exit_attempt_id
         FOR UPDATE;
        IF NOT FOUND THEN RETURN 'INVALID_STATE'; END IF;
        IF v_attempt.trade_id != p_trade_id THEN RETURN 'CONFLICT'; END IF;
        IF v_attempt.status = 'FAILED' THEN RETURN 'INVALID_STATE'; END IF;
        IF v_attempt.tx_signature IS NOT NULL
           AND p_tx_signature IS NOT NULL
           AND v_attempt.tx_signature != p_tx_signature THEN
            RETURN 'INVALID_EVIDENCE';
        END IF;
    END IF;

    IF p_token_delta_raw <= 0
       OR p_sol_delta_lamports < 0
       OR p_fee_lamports < 0
       OR p_token_delta_raw <> trunc(p_token_delta_raw)
       OR p_sol_delta_lamports <> trunc(p_sol_delta_lamports)
       OR p_fee_lamports <> trunc(p_fee_lamports) THEN
        RETURN 'INVALID_EVIDENCE';
    END IF;

    IF p_tx_signature IS NOT NULL THEN
        SELECT *
          INTO v_existing_fill
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

    -- Guard: Only check v_attempt.status if an exit attempt was provided
    IF p_exit_attempt_id IS NOT NULL THEN
        IF v_attempt.status = 'SUCCESS' THEN
            RETURN 'INVALID_STATE';
        END IF;
    END IF;

    IF v_trade.remaining_raw < p_token_delta_raw THEN
        RETURN 'INSUFFICIENT_INVENTORY';
    END IF;

    v_new_remaining_raw := v_trade.remaining_raw - p_token_delta_raw;
    IF v_new_remaining_raw <= 0 THEN
        v_new_status := 'CLOSED';
        v_closed_at := now();
    ELSE
        v_new_status := 'PARTIAL_EXIT';
        v_closed_at := v_trade.closed_at;
    END IF;

    IF v_trade.sol_spent_lamports IS NOT NULL
       AND v_trade.token_amount_raw IS NOT NULL
       AND v_trade.token_amount_raw > 0 THEN
        v_prior_sold_raw := greatest(0, v_trade.token_amount_raw - v_trade.remaining_raw);
        v_cumulative_sold_raw := least(
          v_trade.token_amount_raw,
          v_prior_sold_raw + p_token_delta_raw
        );
        v_cost_before_lamports := floor(
          v_trade.sol_spent_lamports * v_prior_sold_raw / v_trade.token_amount_raw
        );
        v_cost_after_lamports := floor(
          v_trade.sol_spent_lamports * v_cumulative_sold_raw / v_trade.token_amount_raw
        );
        v_cost_lamports := v_cost_after_lamports - v_cost_before_lamports;
        v_entry_fee_before_lamports := floor(
          COALESCE(v_trade.fee_lamports, 0) * v_prior_sold_raw / v_trade.token_amount_raw
        );
        v_entry_fee_after_lamports := floor(
          COALESCE(v_trade.fee_lamports, 0) * v_cumulative_sold_raw / v_trade.token_amount_raw
        );
        v_entry_fee_share_lamports :=
          v_entry_fee_after_lamports - v_entry_fee_before_lamports;
        v_basis_sol := (v_cost_lamports + v_entry_fee_share_lamports) / 1000000000.0;
        v_sol_received := p_sol_delta_lamports / 1000000000.0;
        v_exit_fee_sol := p_fee_lamports / 1000000000.0;
        v_realized_pnl_sol := v_sol_received - v_basis_sol - v_exit_fee_sol;
        v_new_realized_pnl :=
          COALESCE(v_trade.realized_pnl_sol, 0) + v_realized_pnl_sol;

        IF v_basis_sol > 0 THEN
            v_pnl_percent := (v_realized_pnl_sol / v_basis_sol) * 100;
        ELSE
            v_pnl_percent := COALESCE(v_trade.pnl_percent, 0);
        END IF;
    ELSE
        v_realized_pnl_sol := 0;
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
            v_realized_pnl_sol
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
           updated_at = now()
     WHERE id = p_trade_id;

    IF p_exit_attempt_id IS NOT NULL THEN
        UPDATE public.exit_attempts
           SET status = 'SUCCESS',
               tx_signature = COALESCE(p_tx_signature, exit_attempts.tx_signature),
               updated_at = now()
         WHERE id = p_exit_attempt_id;
    END IF;

    RETURN 'APPLIED';
END;
$$ LANGUAGE plpgsql SET search_path = public;

COMMENT ON FUNCTION public.atomic_reconcile_exit(
    UUID,UUID,TEXT,NUMERIC,NUMERIC,NUMERIC,NUMERIC
) IS 'Atomically applies one exit, safely handling null exit_attempt_id for paper trades.';
REVOKE ALL ON FUNCTION public.atomic_reconcile_exit(
    UUID,UUID,TEXT,NUMERIC,NUMERIC,NUMERIC,NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_reconcile_exit(
    UUID,UUID,TEXT,NUMERIC,NUMERIC,NUMERIC,NUMERIC
) TO service_role;
