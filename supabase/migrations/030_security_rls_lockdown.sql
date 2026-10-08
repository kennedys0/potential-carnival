-- Forward-only security boundary hardening. Run after 029.
-- The bot uses Supabase service-role server-side; anon/authenticated clients must not
-- read or mutate financial ledgers, encrypted wallets, or operational state directly.
DO $$
DECLARE
  table_name TEXT;
  table_names TEXT[] := ARRAY[
    'users',
    'user_wallets',
    'user_settings',
    'withdrawals',
    'withdrawal_attempts',
    'trades',
    'positions',
    'exit_attempts',
    'trade_fills',
    'inventory_discrepancies',
    'trade_buy_locks',
    'autopilot_configs',
    'autopilot_states',
    'decision_logs',
    'circuit_breaker_events',
    'sniper_configs',
    'sniper_states',
    'strategy_entry_reservations'
  ];
BEGIN
  FOREACH table_name IN ARRAY table_names LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', table_name);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', table_name);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', table_name);
      END IF;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  fn REGPROCEDURE;
  fn_signatures TEXT[] := ARRAY[
    'public.atomic_reconcile_exit(uuid,uuid,text,numeric,numeric,numeric,numeric)',
    'public.atomic_reconcile_entry(uuid,text,text,numeric,integer,numeric,numeric,numeric,numeric,numeric,boolean)',
    'public.atomic_create_withdrawal(bigint,numeric,text,text,numeric)',
    'public.atomic_claim_withdrawal(uuid,bigint)',
    'public.acquire_buy_lock(bigint,text,uuid,integer)',
    'public.release_buy_lock(bigint,text,uuid)',
    'public.verify_buy_lock(bigint,text,uuid)',
    'public.get_daily_trade_stats(bigint,text)',
    'public.get_closed_trades_today(bigint,text)',
    'public.reserve_strategy_entry(bigint,text,trading_strategy,boolean,bigint,integer,integer,integer,bigint,bigint)',
    'public.finish_strategy_reservation(uuid,text)',
    'public.release_strategy_reservation(uuid)'
  ];
  fn_signature TEXT;
BEGIN
  FOREACH fn_signature IN ARRAY fn_signatures LOOP
    fn := to_regprocedure(fn_signature);
    IF fn IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
      END IF;
    END IF;
  END LOOP;
END $$;
