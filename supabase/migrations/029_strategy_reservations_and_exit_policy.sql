-- Forward-only migration. Run AFTER 028; NEVER replay or edit old financial migrations.
-- Conservative atomic reservations for both strategies and per-position exit-policy snapshots.
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS exit_policy_snapshot JSONB;

CREATE TABLE IF NOT EXISTS public.strategy_entry_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
  token_mint TEXT NOT NULL,
  trade_id UUID UNIQUE REFERENCES public.trades(id) ON DELETE SET NULL,
  strategy trading_strategy NOT NULL,
  is_dry_run BOOLEAN NOT NULL,
  amount_lamports BIGINT NOT NULL CHECK (amount_lamports > 0),
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','IN_FLIGHT','COMPLETED','RELEASED')),
  accounting_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The reservation ledger is server-only. Supabase public-schema defaults vary,
-- so explicitly deny anonymous/authenticated access, not just EXECUTE on RPCs.
ALTER TABLE public.strategy_entry_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.strategy_entry_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.strategy_entry_reservations TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS strategy_entry_one_inflight_mint
ON public.strategy_entry_reservations(user_id, token_mint)
WHERE status IN ('RESERVED','IN_FLIGHT');
CREATE INDEX IF NOT EXISTS strategy_entry_user_date
ON public.strategy_entry_reservations(user_id, strategy, accounting_date);

-- Backfill CURRENT UTC DAY attempts from the pre-029 sniper implementation.
-- This only writes reservation/accounting metadata. NEVER close or merge a trade.
INSERT INTO public.strategy_entry_reservations
 (user_id, token_mint, trade_id, strategy, is_dry_run, amount_lamports, status, accounting_date)
SELECT t.user_id, t.token_mint, t.id, t.strategy, COALESCE(t.is_dry_run,FALSE),
       CEIL(t.sol_amount * 1000000000)::BIGINT,
       CASE WHEN t.status IN ('OPEN','PARTIAL_EXIT','CLOSED') THEN 'COMPLETED' ELSE 'IN_FLIGHT' END,
       (t.created_at AT TIME ZONE 'UTC')::DATE
FROM public.trades t
WHERE t.strategy IN ('NEW_TOKEN_SNIPER','TRENDING') AND t.source='AUTOPILOT' AND t.side='BUY'
  AND t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT','CLOSED')
  AND t.sol_amount > 0
  AND (t.created_at AT TIME ZONE 'UTC')::DATE = (now() AT TIME ZONE 'UTC')::DATE
ON CONFLICT (trade_id) DO NOTHING;

-- All workers for one user serialize on the SAME user row. A single database transaction
-- checks limits and inserts the reservation; application read-modify-write counters are unsafe.
CREATE OR REPLACE FUNCTION public.reserve_strategy_entry(
 p_user_id BIGINT, p_token_mint TEXT, p_strategy trading_strategy,
 p_is_dry_run BOOLEAN, p_amount_lamports BIGINT,
 p_max_strategy_positions INT, p_max_global_positions INT,
 p_max_daily_buys INT, p_max_daily_lamports BIGINT,
 p_available_lamports BIGINT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
 v_id UUID;
 v_today DATE := (now() AT TIME ZONE 'UTC')::date;
 v_existing INT;
 v_strategy_existing INT;
 v_daily_count INT;
 v_daily_lamports NUMERIC;
 v_unsettled_lamports NUMERIC;
 v_enabled BOOLEAN;
BEGIN
 IF p_user_id IS NULL OR p_token_mint IS NULL OR length(p_token_mint) < 32
   OR p_amount_lamports IS NULL OR p_amount_lamports <= 0
   OR p_available_lamports IS NULL OR p_available_lamports < p_amount_lamports
   OR p_max_strategy_positions IS NULL OR p_max_strategy_positions < 1
   OR p_max_global_positions IS NULL OR p_max_global_positions < 1
   OR p_max_daily_buys IS NULL OR p_max_daily_buys < 1
   OR p_max_daily_lamports IS NULL OR p_max_daily_lamports < p_amount_lamports THEN
   RETURN NULL;
 END IF;

 PERFORM 1 FROM public.users WHERE telegram_id = p_user_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;

 IF p_strategy = 'NEW_TOKEN_SNIPER' THEN
   SELECT enabled AND (trading_mode = CASE WHEN p_is_dry_run THEN 'PAPER' ELSE 'LIVE' END)
     INTO v_enabled FROM public.sniper_configs WHERE user_id = p_user_id;
 ELSE
   SELECT is_active AND (mode = CASE WHEN p_is_dry_run THEN 'PAPER' ELSE 'LIVE' END)
     INTO v_enabled FROM public.autopilot_configs WHERE user_id = p_user_id;
 END IF;
 IF v_enabled IS DISTINCT FROM TRUE THEN RETURN NULL; END IF;

 -- Never buy the same mint twice across strategies, regardless of paper/live mode.
 IF EXISTS (SELECT 1 FROM public.trades t WHERE t.user_id = p_user_id
     AND t.side = 'BUY' AND t.token_mint = p_token_mint
     AND t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT'))
   OR EXISTS (SELECT 1 FROM public.strategy_entry_reservations r
       WHERE r.user_id = p_user_id AND r.token_mint = p_token_mint
       AND r.status IN ('RESERVED','IN_FLIGHT')) THEN
   RETURN NULL;
 END IF;

 -- Count existing trades plus reservations which do not already have an active trade.
 SELECT count(*) INTO v_existing FROM public.trades t WHERE t.user_id=p_user_id
   AND t.side='BUY' AND t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT');
 SELECT v_existing + count(*) INTO v_existing FROM public.strategy_entry_reservations r
   WHERE r.user_id=p_user_id AND r.status IN ('RESERVED','IN_FLIGHT')
   AND NOT EXISTS (SELECT 1 FROM public.trades t WHERE t.user_id=r.user_id
     AND t.token_mint=r.token_mint AND t.side='BUY'
     AND t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT'));
 IF v_existing >= p_max_global_positions THEN RETURN NULL; END IF;

 SELECT count(*) INTO v_strategy_existing FROM public.trades t WHERE t.user_id=p_user_id
   AND t.side='BUY' AND t.source='AUTOPILOT' AND t.strategy=p_strategy
   AND t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT');
 SELECT v_strategy_existing + count(*) INTO v_strategy_existing FROM public.strategy_entry_reservations r
   WHERE r.user_id=p_user_id AND r.strategy=p_strategy AND r.status IN ('RESERVED','IN_FLIGHT')
   AND NOT EXISTS (SELECT 1 FROM public.trades t WHERE t.user_id=r.user_id
     AND t.token_mint=r.token_mint AND t.side='BUY'
     AND t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT'));
 IF v_strategy_existing >= p_max_strategy_positions THEN RETURN NULL; END IF;

 SELECT count(*), coalesce(sum(amount_lamports),0)
   INTO v_daily_count, v_daily_lamports FROM public.strategy_entry_reservations
   WHERE user_id=p_user_id AND strategy=p_strategy AND accounting_date=v_today
     AND status <> 'RELEASED';
 IF v_daily_count >= p_max_daily_buys
    OR v_daily_lamports + p_amount_lamports > p_max_daily_lamports THEN
    RETURN NULL;
 END IF;

 -- Conservative wallet balance: subtract unsettled reserved amounts. Active trades
 -- are already deducted by UserStateService when their status is still pending.
 SELECT coalesce(sum(r.amount_lamports),0) INTO v_unsettled_lamports
 FROM public.strategy_entry_reservations r
 WHERE r.user_id=p_user_id AND r.is_dry_run=p_is_dry_run
   AND r.status IN ('RESERVED','IN_FLIGHT')
   AND NOT EXISTS (SELECT 1 FROM public.trades t WHERE t.user_id=r.user_id
       AND t.token_mint=r.token_mint AND t.side='BUY'
       AND t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT'));
 IF v_unsettled_lamports + p_amount_lamports > p_available_lamports THEN RETURN NULL; END IF;

 INSERT INTO public.strategy_entry_reservations
  (user_id, token_mint, strategy, is_dry_run, amount_lamports, accounting_date)
 VALUES (p_user_id, p_token_mint, p_strategy, p_is_dry_run, p_amount_lamports, v_today)
 RETURNING id INTO v_id;
 RETURN v_id;
END $$;

-- The ONLY authoritative completed-state transition is a fully-accounted trade.
-- A trigger runs in the same PostgreSQL transaction as position fill accounting,
-- including late confirmations recovered by the reconciliation worker.
CREATE OR REPLACE FUNCTION public.complete_reservation_on_verified_entry()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.source='AUTOPILOT' AND NEW.side='BUY'
     AND NEW.status IN ('OPEN','PARTIAL_EXIT','CLOSED')
     AND NEW.token_amount_raw IS NOT NULL AND NEW.token_amount_raw > 0
     AND (COALESCE(NEW.is_dry_run,FALSE) OR NEW.tx_signature IS NOT NULL) THEN
    UPDATE public.strategy_entry_reservations
       SET status='COMPLETED',trade_id=NEW.id,updated_at=now()
     WHERE user_id=NEW.user_id AND token_mint=NEW.token_mint
       AND strategy=NEW.strategy AND status IN ('RESERVED','IN_FLIGHT');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS strategy_entry_complete ON public.trades;
CREATE TRIGGER strategy_entry_complete
AFTER INSERT OR UPDATE ON public.trades
FOR EACH ROW EXECUTE FUNCTION public.complete_reservation_on_verified_entry();

CREATE OR REPLACE FUNCTION public.finish_strategy_reservation(p_id UUID, p_status TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_current TEXT;
BEGIN
 IF p_status NOT IN ('IN_FLIGHT','COMPLETED') THEN RETURN FALSE; END IF;
 SELECT status INTO v_current FROM public.strategy_entry_reservations WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 -- The fill-accounting trigger can advance the reservation before the worker returns.
 IF v_current='COMPLETED' THEN RETURN TRUE; END IF;
 IF v_current NOT IN ('RESERVED','IN_FLIGHT') THEN RETURN FALSE; END IF;
 UPDATE public.strategy_entry_reservations
 SET status=p_status, updated_at=now()
 WHERE id=p_id;
 RETURN TRUE;
END $$;

-- Safe release only when no trade can represent a broadcast/uncertain BUY.
-- Even a FAILED trade with a durable signature must hold its reservation pending proof.
CREATE OR REPLACE FUNCTION public.release_strategy_reservation(p_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_record public.strategy_entry_reservations%ROWTYPE;
BEGIN
 SELECT * INTO v_record FROM public.strategy_entry_reservations WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_record.status NOT IN ('RESERVED','IN_FLIGHT') THEN RETURN FALSE; END IF;
 IF EXISTS (SELECT 1 FROM public.trades t
       WHERE t.user_id=v_record.user_id AND t.token_mint=v_record.token_mint AND t.side='BUY'
       AND (t.status IN ('RESERVED','SIGNED','BROADCAST_ATTEMPTED','PENDING','OPEN','PARTIAL_EXIT')
         OR t.tx_signature IS NOT NULL OR t.pending_signature IS NOT NULL)) THEN
   RETURN FALSE;
 END IF;
 UPDATE public.strategy_entry_reservations SET status='RELEASED',updated_at=now() WHERE id=p_id;
 RETURN TRUE;
END $$;

REVOKE ALL ON FUNCTION public.complete_reservation_on_verified_entry() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_strategy_entry(BIGINT,TEXT,trading_strategy,BOOLEAN,BIGINT,INT,INT,INT,BIGINT,BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_strategy_reservation(UUID,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_strategy_reservation(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_strategy_entry(BIGINT,TEXT,trading_strategy,BOOLEAN,BIGINT,INT,INT,INT,BIGINT,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_strategy_reservation(UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_strategy_reservation(UUID) TO service_role;
