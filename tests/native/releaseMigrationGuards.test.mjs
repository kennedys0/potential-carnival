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
