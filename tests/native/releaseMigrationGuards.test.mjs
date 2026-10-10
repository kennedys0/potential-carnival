import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const load = (name) => fs.readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const repo = fs.readFileSync(new URL('../../src/database/repositories/tradeRepository.ts', import.meta.url), 'utf8');

test('022 does not rewrite historical trades in order to satisfy a unique index', () => {
  const sql = load('022_round9_buy_intent_constraint.sql');
  assert.match(sql, /RAISE EXCEPTION 'BUY_INTENT_MIGRATION_BLOCKED/);
  assert.doesNotMatch(sql, /UPDATE\s+trades\s+SET/i);
  assert.match(sql, /HAVING COUNT\(\*\) > 1/);
});
test('025 and 027 use the same strict entry reconciliation implementation', () => {
  const sql025 = load('025_round9_entry_reconcile_states.sql');
  const sql027 = load('027_final_entry_integrity.sql');
  assert.equal(sql027.slice(sql027.indexOf('CREATE OR REPLACE FUNCTION')), sql025.slice(sql025.indexOf('CREATE OR REPLACE FUNCTION')));
  assert.match(sql027, /v_trade\.pending_signature IS DISTINCT FROM p_tx_signature/);
  assert.match(sql027, /p_remaining_raw <> p_token_amount_raw/);
  assert.match(sql027, /v_trade\.status NOT IN \('SIGNED', 'BROADCAST_ATTEMPTED', 'PENDING'\)/);
  assert.match(sql027, /p_sol_spent_lamports::BIGINT/);
  assert.match(sql027, /p_status IS DISTINCT FROM 'OPEN'/);
  assert.doesNotMatch(sql027, /COALESCE\(p_sol_spent_lamports::TEXT/);
});
test('application refuses unsupported or misleading SQL reconciliation statuses', () => {
  const entry = repo.slice(repo.indexOf('async atomicReconcileEntry('), repo.indexOf('async acquireBuyLock('));
  assert.match(entry, /data === 'APPLIED'/);
  assert.match(entry, /data === 'ALREADY_APPLIED'/);
  assert.doesNotMatch(entry, /ALREADY_RESOLVED/);
  assert.match(entry, /throw new Error\(`Entry reconciliation rejected/);
});

test('030 locks sensitive tables and financial RPCs away from anon clients', () => {
  const sql = load('030_security_rls_lockdown.sql');
  for (const tableName of ['user_wallets', 'withdrawal_attempts', 'trades', 'trade_fills', 'strategy_entry_reservations']) {
    assert.match(sql, new RegExp(`'${tableName}'`));
  }
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM anon/);
  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM anon/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
});
test('031 aligns live schema with application queries and withdrawal cancellation', () => {
  const sql = load('031_live_schema_alignment.sql');
  assert.match(sql, /ALTER TABLE public\.trades\s+ADD COLUMN IF NOT EXISTS updated_at/i);
  assert.match(sql, /withdrawal_attempts_user_id_fkey/i);
  assert.match(sql, /inventory_discrepancies_user_id_fkey/i);
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/i);
  for (const indexName of [
    'trades_user_status_idx',
    'trades_inflight_signature_idx',
    'exit_attempts_trade_status_idx',
    'withdrawal_attempts_status_updated_idx',
    'decision_logs_user_timestamp_idx',
  ]) {
    assert.match(sql, new RegExp(indexName));
  }

  const walletRepo = fs.readFileSync(new URL('../../src/database/repositories/walletRepository.ts', import.meta.url), 'utf8');
  const walletHandler = fs.readFileSync(new URL('../../src/modules/telegram/handlers/walletHandler.ts', import.meta.url), 'utf8');
  const router = fs.readFileSync(new URL('../../src/modules/telegram/router.ts', import.meta.url), 'utf8');
  assert.match(walletRepo, /cancelAuthorizedWithdrawal/);
  assert.match(walletRepo, /\.eq\('status', 'AUTHORIZED'\)/);
  assert.match(walletHandler, /withdraw_cancel:\$\{withdrawalId\}/);
  assert.match(router, /withdraw_cancel:/);
});

test('migration versions are unique and remediation isolates enum extension', () => {
  const names = fs.readdirSync(new URL('../../supabase/migrations/', import.meta.url));
  const versions = names.map((name) => name.split('_', 1)[0]);
  assert.equal(new Set(versions).size, versions.length);

  const enumSql = load('034_add_copy_trade_strategy.sql');
  const remediationSql = load('035_production_safety_remediation.sql');
  assert.match(enumSql, /ADD VALUE IF NOT EXISTS 'COPY_TRADE'/);
  assert.match(remediationSql, /Exit signatures belong exclusively to exit_attempts\.tx_signature/);
  assert.match(remediationSql, /'SIGNED','BROADCAST_ATTEMPTED','CONFIRMING'/);
});

test('copy-trade targets are server-only and cannot bypass backend limits', () => {
  const sql = load('035_production_safety_remediation.sql');
  assert.match(sql, /DROP POLICY IF EXISTS "Users can manage their own copy trade targets"/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.copy_trade_targets FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.copy_trade_targets TO service_role/);
  assert.match(sql, /CHECK \(max_buy_usd > 0 AND max_buy_usd <= 10000\)/);

  const trader = fs.readFileSync(new URL('../../src/modules/trader/traderService.ts', import.meta.url), 'utf8');
  const closePosition = trader.slice(trader.indexOf('async closePosition('), trader.indexOf('private jupiterIntent('));
  assert.doesNotMatch(closePosition, /pending_signature/);
  assert.match(closePosition, /updateExitAttempt\(exitAttempt\.id, \{ tx_signature: sig, status: 'SIGNED' \}\)/);
});
