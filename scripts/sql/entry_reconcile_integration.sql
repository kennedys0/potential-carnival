-- Run ONLY against an isolated test database with ALL migrations applied through 027.
-- Example (test DB only):
-- PGOPTIONS='-c app.confirm_isolated_test_db=yes' psql "$TEST_DATABASE_URL" \
--   -v ON_ERROR_STOP=1 -f scripts/sql/entry_reconcile_integration.sql
-- Every inserted test record is rolled back at the end.
BEGIN;
DO $$
BEGIN
  IF current_setting('app.confirm_isolated_test_db', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'REFUSING_TO_TEST_NON_ISOLATED_DATABASE';
  END IF;
END;
$$;
DO $$
DECLARE
  v_user BIGINT := -717171717;
  v_trade UUID := gen_random_uuid();
  v_closed UUID := gen_random_uuid();
  v_result TEXT;
  v_status position_status;
  v_raw NUMERIC;
  v_nfills INTEGER;
BEGIN
  INSERT INTO users (telegram_id, username)
  VALUES (v_user, 'r9_patch_integration_test')
  ON CONFLICT (telegram_id) DO NOTHING;
  INSERT INTO trades (id, user_id, token_mint, token_symbol, side, source, is_dry_run,
                      sol_amount, token_amount, entry_price_usd, status, pending_signature)
  VALUES (v_trade, v_user, 'INTEGRATION_MINT_1', 'TEST', 'BUY', 'MANUAL', FALSE,
          0.5, 0, 1, 'BROADCAST_ATTEMPTED', 'TEST_SIGNATURE_R9');

  SELECT atomic_reconcile_entry(v_trade, 'OPEN', NULL, 1000000, 6, 500000000, 1000000, 5000, 0.5, 1, FALSE) INTO v_result;
  IF v_result <> 'INVALID_EVIDENCE' THEN RAISE EXCEPTION 'missing signature accepted: %', v_result; END IF;
  SELECT atomic_reconcile_entry(v_trade, 'OPEN', 'WRONG_SIGNATURE', 1000000, 6, 500000000, 1000000, 5000, 0.5, 1, FALSE) INTO v_result;
  IF v_result <> 'INVALID_EVIDENCE' THEN RAISE EXCEPTION 'wrong signature accepted: %', v_result; END IF;
  SELECT atomic_reconcile_entry(v_trade, 'OPEN', 'TEST_SIGNATURE_R9', 999999, 6, 500000000, 1000000, 5000, 0.5, 1, FALSE) INTO v_result;
  IF v_result <> 'INVALID_EVIDENCE' THEN RAISE EXCEPTION 'invalid inventory accepted: %', v_result; END IF;

  SELECT atomic_reconcile_entry(v_trade, 'OPEN', 'TEST_SIGNATURE_R9', 1000000, 6, 500000000, 1000000, 5000, 0.5, 1, FALSE) INTO v_result;
  IF v_result <> 'APPLIED' THEN RAISE EXCEPTION 'valid fill rejected: %', v_result; END IF;
  SELECT status, remaining_raw INTO v_status, v_raw FROM trades WHERE id = v_trade;
  IF v_status <> 'OPEN' OR v_raw <> 1000000 THEN RAISE EXCEPTION 'wrong inventory after fill'; END IF;
  SELECT COUNT(*) INTO v_nfills FROM trade_fills WHERE trade_id = v_trade;
  IF v_nfills <> 1 THEN RAISE EXCEPTION 'fill not recorded'; END IF;
  SELECT atomic_reconcile_entry(v_trade, 'OPEN', 'TEST_SIGNATURE_R9', 1000000, 6, 500000000, 1000000, 5000, 0.5, 1, FALSE) INTO v_result;
  IF v_result <> 'ALREADY_APPLIED' THEN RAISE EXCEPTION 'idempotent replay failed: %', v_result; END IF;
  SELECT atomic_reconcile_entry(v_trade, 'OPEN', 'TEST_SIGNATURE_R9', 2000000, 6, 500000000, 2000000, 5000, 0.5, 2, FALSE) INTO v_result;
  IF v_result <> 'CONFLICT' THEN RAISE EXCEPTION 'changed fill replay accepted: %', v_result; END IF;
  SELECT COUNT(*) INTO v_nfills FROM trade_fills WHERE trade_id = v_trade;
  IF v_nfills <> 1 THEN RAISE EXCEPTION 'idempotent replay changed ledger'; END IF;

  INSERT INTO trades (id, user_id, token_mint, token_symbol, side, source, is_dry_run,
                      sol_amount, token_amount, entry_price_usd, status, pending_signature)
  VALUES (v_closed, v_user, 'INTEGRATION_MINT_2', 'TEST', 'BUY', 'MANUAL', FALSE,
          0.5, 0, 1, 'CLOSED', 'OLD_SIG');
  SELECT atomic_reconcile_entry(v_closed, 'OPEN', 'OLD_SIG', 1000000, 6, 500000000, 1000000, 5000, 0.5, 1, FALSE) INTO v_result;
  IF v_result <> 'INVALID_STATE' THEN RAISE EXCEPTION 'CLOSED reopened: %', v_result; END IF;
END;
$$;
ROLLBACK;
