-- Forward-only live-readiness hardening after 030.
-- Aligns the final schema with application queries/RPC updates and adds operational indexes.

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Preserve withdrawal/inventory ownership integrity for new rows without failing on
-- possible historical orphan rows from earlier migrations.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'withdrawal_attempts_user_id_fkey'
  ) THEN
    ALTER TABLE public.withdrawal_attempts
      ADD CONSTRAINT withdrawal_attempts_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(telegram_id)
      ON DELETE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_discrepancies_user_id_fkey'
  ) THEN
    ALTER TABLE public.inventory_discrepancies
      ADD CONSTRAINT inventory_discrepancies_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(telegram_id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

-- Supabase/Postgres least-privilege baseline. Runtime uses service_role only.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO service_role';
  END IF;
END $$;

-- Query/FK support indexes used by schedulers, scanners, reconciliation and reports.
CREATE INDEX IF NOT EXISTS trades_user_status_idx
  ON public.trades (user_id, status);
CREATE INDEX IF NOT EXISTS trades_status_created_idx
  ON public.trades (status, created_at);
CREATE INDEX IF NOT EXISTS trades_user_closed_at_idx
  ON public.trades (user_id, closed_at DESC)
  WHERE status = 'CLOSED';
CREATE INDEX IF NOT EXISTS trades_inflight_signature_idx
  ON public.trades (status, pending_signature)
  WHERE status IN ('PENDING', 'SIGNED', 'BROADCAST_ATTEMPTED');

CREATE INDEX IF NOT EXISTS exit_attempts_trade_status_idx
  ON public.exit_attempts (trade_id, status);
CREATE INDEX IF NOT EXISTS exit_attempts_pending_idx
  ON public.exit_attempts (status, created_at)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS withdrawal_attempts_user_status_idx
  ON public.withdrawal_attempts (user_id, status);
CREATE INDEX IF NOT EXISTS withdrawal_attempts_status_updated_idx
  ON public.withdrawal_attempts (status, updated_at);

CREATE INDEX IF NOT EXISTS trade_fills_trade_created_idx
  ON public.trade_fills (trade_id, created_at);
CREATE INDEX IF NOT EXISTS trade_fills_exit_attempt_idx
  ON public.trade_fills (exit_attempt_id)
  WHERE exit_attempt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS decision_logs_user_timestamp_idx
  ON public.decision_logs (user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS decision_logs_user_action_idx
  ON public.decision_logs (user_id, action);

CREATE INDEX IF NOT EXISTS circuit_breaker_events_user_triggered_idx
  ON public.circuit_breaker_events (user_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS inventory_discrepancies_user_status_idx
  ON public.inventory_discrepancies (user_id, status, detected_at DESC);