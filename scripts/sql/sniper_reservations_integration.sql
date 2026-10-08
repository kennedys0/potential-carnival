-- TEST ONLY on an ISOLATED PostgreSQL/Supabase database after migrations 001-029.
-- psql -v ON_ERROR_STOP=1 -f scripts/sql/sniper_reservations_integration.sql
-- Always rolls back. Run with a dedicated test database; NEVER against production.
BEGIN;

INSERT INTO public.users(telegram_id, username) VALUES (-20991011, 'sniper_migration_test')
ON CONFLICT (telegram_id) DO NOTHING;
INSERT INTO public.sniper_configs(user_id, enabled, trading_mode, buy_amount_sol,
 max_active_positions,max_buys_per_day,max_daily_entry_budget_sol)
VALUES (-20991011,TRUE,'PAPER',0.01,3,3,0.03)
ON CONFLICT (user_id) DO UPDATE SET enabled=TRUE, trading_mode='PAPER',
 buy_amount_sol=0.01,max_active_positions=3,max_buys_per_day=3,max_daily_entry_budget_sol=0.03;

DO $$
DECLARE r1 UUID; r2 UUID; r3 UUID; r4 UUID; v_status TEXT;
BEGIN
 r1 := public.reserve_strategy_entry(-20991011,'Mint2222222222222222222222222222222222222222222',
   'NEW_TOKEN_SNIPER',TRUE,10000000,3,6,3,30000000,1000000000);
 r2 := public.reserve_strategy_entry(-20991011,'Mint3333333333333333333333333333333333333333333',
   'NEW_TOKEN_SNIPER',TRUE,10000000,3,6,3,30000000,1000000000);
 r3 := public.reserve_strategy_entry(-20991011,'Mint4444444444444444444444444444444444444444444',
   'NEW_TOKEN_SNIPER',TRUE,10000000,3,6,3,30000000,1000000000);
 IF r1 IS NULL OR r2 IS NULL OR r3 IS NULL THEN
    RAISE EXCEPTION 'Sniper should accept three distinct reservations';
 END IF;
 IF public.reserve_strategy_entry(-20991011,'Mint2222222222222222222222222222222222222222222',
   'NEW_TOKEN_SNIPER',TRUE,10000000,3,6,3,30000000,1000000000) IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate mint reservation incorrectly accepted';
 END IF;
 r4 := public.reserve_strategy_entry(-20991011,'Mint5555555555555555555555555555555555555555555',
   'NEW_TOKEN_SNIPER',TRUE,10000000,3,6,3,30000000,1000000000);
 IF r4 IS NOT NULL THEN RAISE EXCEPTION 'Daily max 3 must reject fourth BUY'; END IF;
 IF (SELECT count(*) FROM public.strategy_entry_reservations
    WHERE user_id=-20991011 AND status='RESERVED') <> 3 THEN
    RAISE EXCEPTION 'Exactly three atomic reservations required';
 END IF;
 IF public.finish_strategy_reservation(r1,'IN_FLIGHT') IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Reservation transition failed';
 END IF;
 -- Confirmed paper accounting must automatically complete the matching reservation.
 INSERT INTO public.trades(user_id,token_mint,token_symbol,side,source,is_dry_run,
   sol_amount,token_amount,token_amount_raw,remaining_raw,entry_price_usd,status,strategy)
 VALUES (-20991011,'Mint2222222222222222222222222222222222222222222','TEST',
   'BUY','AUTOPILOT',TRUE,0.01,1000,1000,1000,0.0001,'OPEN','NEW_TOKEN_SNIPER');
 SELECT status INTO v_status FROM public.strategy_entry_reservations WHERE id=r1;
 IF v_status <> 'COMPLETED' THEN
   RAISE EXCEPTION 'Verified entry did not atomically complete reservation (got %)', v_status;
 END IF;
 IF (SELECT count(*) FROM public.strategy_entry_reservations
     WHERE user_id=-20991011 AND status <> 'RELEASED') <> 3 THEN
     RAISE EXCEPTION 'In-flight reservation must continue to consume daily quota';
 END IF;
 RAISE NOTICE 'PASS: exact lamports, duplicate mint, 3 daily reservations, in-flight quota, verified entry completion';
END $$;

ROLLBACK;
