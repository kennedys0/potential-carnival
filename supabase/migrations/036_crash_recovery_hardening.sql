-- Forward-only crash recovery hardening. Run AFTER 035.

ALTER TABLE public.exit_attempts
  ADD COLUMN IF NOT EXISTS blockhash TEXT,
  ADD COLUMN IF NOT EXISTS last_valid_block_height BIGINT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

ALTER TABLE public.exit_attempts
  DROP CONSTRAINT IF EXISTS exit_attempts_status_check;
ALTER TABLE public.exit_attempts
  ADD CONSTRAINT exit_attempts_status_check
  CHECK (status IN ('PENDING','SIGNED','BROADCAST_ATTEMPTED','CONFIRMING','SUCCESS','FAILED','EXPIRED'));

DROP INDEX IF EXISTS public.unique_active_exit_attempt;
CREATE UNIQUE INDEX unique_active_exit_attempt
  ON public.exit_attempts (trade_id)
  WHERE status IN ('PENDING','SIGNED','BROADCAST_ATTEMPTED','CONFIRMING');

COMMENT ON COLUMN public.exit_attempts.blockhash IS
  'Recent blockhash used by this exit transaction; required to prove an unseen signature can no longer land.';

CREATE OR REPLACE FUNCTION public.refresh_strategy_reservation(
  p_id UUID,
  p_user_id BIGINT,
  p_token_mint TEXT,
  p_strategy public.trading_strategy,
  p_is_dry_run BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.strategy_entry_reservations
     SET updated_at = now()
   WHERE id = p_id
     AND user_id = p_user_id
     AND token_mint = p_token_mint
     AND strategy = p_strategy
     AND is_dry_run = p_is_dry_run
     AND status IN ('RESERVED','IN_FLIGHT');
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_strategy_reservations(
  p_stale_before TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
      FROM public.trades t
     WHERE t.user_id = v_reservation.user_id
       AND t.token_mint = v_reservation.token_mint
       AND t.side = 'BUY'
       AND t.source = 'AUTOPILOT'
       AND t.strategy = v_reservation.strategy
       AND t.status IN ('OPEN','PARTIAL_EXIT','CLOSED')
       AND COALESCE(t.token_amount_raw, 0) > 0
       AND (COALESCE(t.is_dry_run, FALSE) OR t.tx_signature IS NOT NULL)
     ORDER BY t.created_at DESC, t.id
     LIMIT 1;

    IF v_verified_trade_id IS NOT NULL THEN
      UPDATE public.strategy_entry_reservations
         SET status = 'COMPLETED', trade_id = v_verified_trade_id, updated_at = now()
       WHERE id = v_reservation.id;
      v_reconciled := v_reconciled + 1;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.trades t
       WHERE t.user_id = v_reservation.user_id
         AND t.token_mint = v_reservation.token_mint
         AND t.side = 'BUY'
         AND t.source = 'AUTOPILOT'
         AND t.strategy = v_reservation.strategy
         AND (
           t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT')
           OR t.tx_signature IS NOT NULL
           OR t.pending_signature IS NOT NULL
         )
    ) THEN
      CONTINUE;
    END IF;

    UPDATE public.strategy_entry_reservations
       SET status = 'RELEASED', updated_at = now()
     WHERE id = v_reservation.id;
    v_reconciled := v_reconciled + 1;
  END LOOP;

  RETURN v_reconciled;
END $$;

REVOKE ALL ON FUNCTION public.refresh_strategy_reservation(
  UUID,BIGINT,TEXT,public.trading_strategy,BOOLEAN
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_stale_strategy_reservations(
  TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_strategy_reservation(
  UUID,BIGINT,TEXT,public.trading_strategy,BOOLEAN
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_strategy_reservations(
  TIMESTAMPTZ
) TO service_role;
