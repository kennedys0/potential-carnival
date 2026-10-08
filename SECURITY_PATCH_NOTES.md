# Potential Carnival — Financial Safety Patch (2026-10-08)

## Scope

Input snapshot: `potential-carnival-main-plis-bbanget.zip`.

This patch repairs **specific verified unsafe execution boundaries**. It does **not** certify the entire system for live trading. Keep `LIVE_TRADING_ENABLED=false` until the release gates below have been completed.

### Changed

- `022_round9_buy_intent_constraint.sql`: removes historical inventory merges and `CLOSED` status fabrication. Stops the migration with an actionable error if duplicate active BUY groups exist. Requires evidence-based manual remediation (do not delete or merge historical positions just to create an index).
- `025_round9_entry_reconcile_states.sql`: live BUY entry may become `OPEN` only from the allowlisted in-flight states, with a persisted matching signature and positive exact token and SOL raw quantities. Strict replay checking and atomic fill+position updates. Types match PostgreSQL schema (`BIGINT`, enum).
- `027_final_entry_integrity.sql`: forward-only replacement of the same function for environments that already applied migration `025`. Does not undo data changes from previous migrations.
- `tradeRepository.ts`: `ALREADY_RESOLVED` is no longer incorrectly treated as an idempotent success.
- `withdrawalVerification.ts`, `walletService.ts`, `reconcileWorker.ts`: exact integer SOL transfer verification; requires source, destination, payer, authorized amount, and successful transaction metadata. Legacy MAX withdrawals without `expected_lamports` stay unresolved for investigation.
- Tests: native tests (run without npm dependencies), Vitest repository contract tests, and an isolated-PostgreSQL SQL integration fixture.

## Important migration rules

1. Back up your database before any migration. **Do not automatically run these against production.**
2. Check Supabase migration history. Modifying `022` or `025` in a ZIP does *not* reapply them if already recorded as applied.
3. For a **fresh database**, run the numbered SQL files `001` through `027` in separate committed migration transactions. In particular, `024` (enum additions) must commit before `026` (index with the new enum values). Stop if `022` reports historical duplicates; investigate them using on-chain evidence.
4. If `022` was already applied in an earlier revision and auto-merged trades, **do not run an arbitrary reversal**. Reconstruct historic fills/position balances from backups and verified transaction evidence first.
5. If `025` is already applied, run the new forward migration `027` after verifying migration history and executing tests on a clone. It overrides the SQL function but does not alter historical trade rows.
6. The entry financial RPC now grants access only to `service_role` (where that PostgreSQL role exists). Never put the Supabase service-role key in a browser or Telegram message.

## Tests included

```bash
# No npm install necessary (Node 22):
node --experimental-strip-types --test tests/native/*.test.mjs
npm run guards

# Requires proper dependency installation:
npm ci
npm run verify

# Real PostgreSQL test (isolated database, migrations 001-027 already applied):
PGOPTIONS='-c app.confirm_isolated_test_db=yes' \
  psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/entry_reconcile_integration.sql
```

The SQL integration test runs inside a transaction and issues `ROLLBACK`; it deliberately refuses to run unless the test-mode session setting is explicitly supplied. **Never point it at a production database.**

## Still blocking LIVE trading

- Complete `npm ci`, TypeScript build, full Vitest and SQL integration tests on a provisioned environment.
- Verify actual PostgreSQL migration `001..027`, concurrent BUY/SELL requests and replay, and withdrawal crash recovery using real isolated PostgreSQL/Redis.
- Verify Solana DevNet transaction submission/confirmation, delayed indexing, ambiguous RPC transport errors and worker crash boundaries.
- Review remaining financial precision assumptions and market-price/risk logic; the new entry function is not an independent on-chain oracle.
- Audit the inherited database schema/history before changing existing production data.

**Release verdict: DRY RUN / ISOLATED TESTING ONLY — LIVE NO-GO until all gates pass.**
