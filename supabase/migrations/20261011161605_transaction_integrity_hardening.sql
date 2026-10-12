-- Forward-only transaction integrity hardening. Run after 040.
SET lock_timeout = '5s';

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS strategy_reservation_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'trades_strategy_reservation_id_fkey'
       AND conrelid = 'public.trades'::regclass
  ) THEN
    ALTER TABLE public.trades
      ADD CONSTRAINT trades_strategy_reservation_id_fkey
      FOREIGN KEY (strategy_reservation_id)
      REFERENCES public.strategy_entry_reservations(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS trades_strategy_reservation_unique
  ON public.trades(strategy_reservation_id)
  WHERE strategy_reservation_id IS NOT NULL;

-- The existing ledger already contains an exact trade_id for reservations that
-- completed before this migration. Backfill only those explicit relationships.
UPDATE public.trades AS t
   SET strategy_reservation_id = r.id
  FROM public.strategy_entry_reservations AS r
 WHERE r.trade_id = t.id
   AND t.strategy_reservation_id IS NULL;

CREATE OR REPLACE FUNCTION public.enforce_exact_strategy_reservation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.strategy_reservation_id IS NOT NULL
     AND NEW.strategy_reservation_id IS DISTINCT FROM OLD.strategy_reservation_id THEN
    RAISE EXCEPTION 'strategy_reservation_id is immutable';
  END IF;

  IF NEW.source = 'AUTOPILOT' AND NEW.side = 'BUY' THEN
    IF NEW.strategy_reservation_id IS NULL THEN
      RAISE EXCEPTION 'AUTOPILOT BUY requires an exact strategy reservation';
    END IF;

    PERFORM 1
      FROM public.strategy_entry_reservations AS r
     WHERE r.id = NEW.strategy_reservation_id
       AND r.user_id = NEW.user_id
       AND r.token_mint = NEW.token_mint
       AND r.strategy = NEW.strategy
       AND r.is_dry_run = COALESCE(NEW.is_dry_run, FALSE)
       AND r.status IN ('RESERVED', 'IN_FLIGHT', 'COMPLETED')
       AND (r.trade_id IS NULL OR r.trade_id = NEW.id)
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'strategy reservation does not match this trade';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS exact_strategy_reservation_guard ON public.trades;
CREATE TRIGGER exact_strategy_reservation_guard
BEFORE INSERT OR UPDATE OF strategy_reservation_id, user_id, token_mint, strategy, is_dry_run
ON public.trades
FOR EACH ROW EXECUTE FUNCTION public.enforce_exact_strategy_reservation();

CREATE OR REPLACE FUNCTION public.complete_reservation_on_verified_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.source = 'AUTOPILOT' AND NEW.side = 'BUY' AND NEW.strategy_reservation_id IS NOT NULL THEN
    UPDATE public.strategy_entry_reservations
       SET trade_id = NEW.id,
           status = CASE
             WHEN NEW.status IN ('OPEN','PARTIAL_EXIT','CLOSED')
               AND COALESCE(NEW.token_amount_raw, 0) > 0
               AND (COALESCE(NEW.is_dry_run, FALSE) OR NEW.tx_signature IS NOT NULL)
             THEN 'COMPLETED'
             ELSE status
           END,
           updated_at = now()
     WHERE id = NEW.strategy_reservation_id
       AND user_id = NEW.user_id
       AND token_mint = NEW.token_mint
       AND strategy = NEW.strategy
       AND is_dry_run = COALESCE(NEW.is_dry_run, FALSE)
       AND status IN ('RESERVED','IN_FLIGHT','COMPLETED')
       AND (trade_id IS NULL OR trade_id = NEW.id);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.finish_strategy_reservation(p_id UUID, p_status TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current TEXT;
BEGIN
  IF p_status NOT IN ('IN_FLIGHT','COMPLETED') THEN RETURN FALSE; END IF;

  SELECT status
    INTO v_current
    FROM public.strategy_entry_reservations
   WHERE id = p_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF v_current = 'COMPLETED' THEN RETURN TRUE; END IF;
  IF v_current NOT IN ('RESERVED','IN_FLIGHT') THEN RETURN FALSE; END IF;

  IF p_status = 'COMPLETED' AND NOT EXISTS (
    SELECT 1
      FROM public.trades AS t
     WHERE t.strategy_reservation_id = p_id
       AND t.status IN ('OPEN','PARTIAL_EXIT','CLOSED')
       AND COALESCE(t.token_amount_raw, 0) > 0
       AND (COALESCE(t.is_dry_run, FALSE) OR t.tx_signature IS NOT NULL)
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.strategy_entry_reservations
     SET status = p_status,
         updated_at = now()
   WHERE id = p_id;
  RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION public.release_strategy_reservation(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record public.strategy_entry_reservations%ROWTYPE;
BEGIN
  SELECT *
    INTO v_record
    FROM public.strategy_entry_reservations
   WHERE id = p_id
   FOR UPDATE;
  IF NOT FOUND OR v_record.status NOT IN ('RESERVED','IN_FLIGHT') THEN RETURN FALSE; END IF;

  IF EXISTS (
    SELECT 1
      FROM public.trades AS t
     WHERE t.strategy_reservation_id = p_id
       AND (
         t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT')
         OR t.tx_signature IS NOT NULL
         OR t.pending_signature IS NOT NULL
       )
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.strategy_entry_reservations
     SET status = 'RELEASED',
         updated_at = now()
   WHERE id = p_id;
  RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_strategy_reservations(
  p_stale_before TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservation public.strategy_entry_reservations%ROWTYPE;
  v_verified_trade_id UUID;
  v_reconciled INTEGER := 0;
BEGIN
  IF p_stale_before IS NULL OR p_stale_before > now() - interval '1 minute' THEN
    RETURN 0;
  END IF;

  FOR v_reservation IN
    SELECT *
      FROM public.strategy_entry_reservations
     WHERE status IN ('RESERVED','IN_FLIGHT')
       AND updated_at < p_stale_before
     ORDER BY id
     FOR UPDATE SKIP LOCKED
  LOOP
    v_verified_trade_id := NULL;
    SELECT t.id
      INTO v_verified_trade_id
      FROM public.trades AS t
     WHERE (t.strategy_reservation_id = v_reservation.id OR t.id = v_reservation.trade_id)
       AND t.status IN ('OPEN','PARTIAL_EXIT','CLOSED')
       AND COALESCE(t.token_amount_raw, 0) > 0
       AND (COALESCE(t.is_dry_run, FALSE) OR t.tx_signature IS NOT NULL)
     LIMIT 1;

    IF v_verified_trade_id IS NOT NULL THEN
      UPDATE public.strategy_entry_reservations
         SET status = 'COMPLETED',
             trade_id = v_verified_trade_id,
             updated_at = now()
       WHERE id = v_reservation.id;
      v_reconciled := v_reconciled + 1;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.trades AS t
       WHERE (t.strategy_reservation_id = v_reservation.id OR t.id = v_reservation.trade_id)
         AND (
           t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT')
           OR t.tx_signature IS NOT NULL
           OR t.pending_signature IS NOT NULL
         )
    ) THEN
      CONTINUE;
    END IF;

    UPDATE public.strategy_entry_reservations
       SET status = 'RELEASED',
           updated_at = now()
     WHERE id = v_reservation.id;
    v_reconciled := v_reconciled + 1;
  END LOOP;

  RETURN v_reconciled;
END $$;

CREATE OR REPLACE FUNCTION public.get_daily_realized_pnl_events(
  p_user_id BIGINT,
  p_timezone TEXT
) RETURNS TABLE (
  trade_id UUID,
  realized_pnl_sol NUMERIC,
  occurred_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT f.trade_id,
         COALESCE(f.realized_pnl_sol, 0),
         f.created_at
    FROM public.trade_fills AS f
    JOIN public.trades AS t ON t.id = f.trade_id
   WHERE t.user_id = p_user_id
     AND f.created_at >= (now() AT TIME ZONE p_timezone)::date AT TIME ZONE p_timezone
   ORDER BY f.created_at ASC, f.id ASC
$$;

REVOKE ALL ON FUNCTION public.enforce_exact_strategy_reservation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_reservation_on_verified_entry() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_strategy_reservation(UUID,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_strategy_reservation(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_stale_strategy_reservations(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_daily_realized_pnl_events(BIGINT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_strategy_reservation(UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_strategy_reservation(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_strategy_reservations(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_daily_realized_pnl_events(BIGINT,TEXT) TO service_role;

-- Allocate both principal and the immutable entry transaction fee cumulatively.
-- Cumulative integer division makes partial fills telescope: the final exit
-- consumes every lamport exactly once, with no rounding dust.
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
) IS 'Atomically applies one exit, including cumulative allocation of the immutable entry fee.';
REVOKE ALL ON FUNCTION public.atomic_reconcile_exit(
    UUID,UUID,TEXT,NUMERIC,NUMERIC,NUMERIC,NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_reconcile_exit(
    UUID,UUID,TEXT,NUMERIC,NUMERIC,NUMERIC,NUMERIC
) TO service_role;

CREATE TABLE IF NOT EXISTS public.copy_trade_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id UUID REFERENCES public.copy_trade_targets(id) ON DELETE SET NULL,
  user_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
  target_wallet_address TEXT NOT NULL
    CHECK (target_wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  source_signature TEXT NOT NULL
    CHECK (source_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  token_mint TEXT NOT NULL
    CHECK (token_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  max_buy_usd NUMERIC NOT NULL CHECK (max_buy_usd > 0 AND max_buy_usd <= 10000),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','RETRY','COMPLETED','REJECTED','NEEDS_ATTENTION')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  trade_id UUID REFERENCES public.trades(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, target_wallet_address, source_signature)
);

ALTER TABLE public.copy_trade_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.copy_trade_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.copy_trade_deliveries TO service_role;

CREATE INDEX IF NOT EXISTS copy_trade_deliveries_retryable_idx
  ON public.copy_trade_deliveries(next_attempt_at, created_at)
  WHERE status IN ('PENDING','RETRY','PROCESSING');

CREATE OR REPLACE FUNCTION public.claim_copy_trade_delivery()
RETURNS SETOF public.copy_trade_deliveries
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.copy_trade_deliveries AS delivery
     SET status = 'PROCESSING',
         attempts = delivery.attempts + 1,
         locked_at = now(),
         updated_at = now()
   WHERE delivery.id = (
     SELECT candidate.id
       FROM public.copy_trade_deliveries AS candidate
      WHERE (
          candidate.status IN ('PENDING','RETRY')
          AND candidate.next_attempt_at <= now()
        )
         OR (
          candidate.status = 'PROCESSING'
          AND candidate.locked_at < now() - interval '5 minutes'
        )
      ORDER BY candidate.next_attempt_at, candidate.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING delivery.*
$$;

CREATE OR REPLACE FUNCTION public.finish_copy_trade_delivery(
  p_id UUID,
  p_attempt INTEGER,
  p_status TEXT,
  p_last_error TEXT,
  p_trade_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_id IS NULL
     OR p_attempt IS NULL
     OR p_attempt < 1
     OR p_status NOT IN ('RETRY','COMPLETED','REJECTED','NEEDS_ATTENTION') THEN
    RETURN FALSE;
  END IF;

  IF p_status = 'COMPLETED' AND NOT EXISTS (
    SELECT 1
      FROM public.copy_trade_deliveries AS d
      JOIN public.trades AS t
        ON t.id = p_trade_id
       AND t.user_id = d.user_id
       AND t.strategy = 'COPY_TRADE'
       AND t.copy_target_wallet = d.target_wallet_address
       AND t.copy_source_signature = d.source_signature
     WHERE d.id = p_id
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.copy_trade_deliveries
     SET status = p_status,
         trade_id = CASE WHEN p_status = 'COMPLETED' THEN p_trade_id ELSE trade_id END,
         last_error = left(p_last_error, 2000),
         locked_at = NULL,
         next_attempt_at = CASE
           WHEN p_status = 'RETRY'
           THEN now() + make_interval(secs => least(300, power(2, least(p_attempt, 8))::INTEGER))
           ELSE next_attempt_at
         END,
         completed_at = CASE WHEN p_status = 'RETRY' THEN NULL ELSE now() END,
         updated_at = now()
   WHERE id = p_id
     AND status = 'PROCESSING'
     AND attempts = p_attempt;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.claim_copy_trade_delivery() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_copy_trade_delivery(UUID,INTEGER,TEXT,TEXT,UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_copy_trade_delivery() TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_copy_trade_delivery(UUID,INTEGER,TEXT,TEXT,UUID)
  TO service_role;
