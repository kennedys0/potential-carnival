# Dual Autopilot Sniper — Safety Fix Review

**Source:** `potential-carnival-feat-new-token-sniper-dual-autopilot.zip`.
**Patch status:** REVIEW / PAPER-ONLY. **Not certified safe for live funds.**

## Repaired in source

1. Invalid `UNKNOWN` / `CONFIRMING` position enum filtering replaced with valid `RESERVED`, `SIGNED`, `BROADCAST_ATTEMPTED`, `PENDING`, `OPEN`, `PARTIAL_EXIT`; pending exposure counted.
2. New-pool discovery now checks **the same pair address** on GeckoTerminal and DexScreener, plus pool timestamp agreement. Reversed settlement-asset base pairs are conservatively skipped. Pool-age bounds (minimum 20 seconds, maximum 5 minutes by default) are enforced per user.
3. Redis no longer permanently marks a candidate as scanned before safety, liquidity, price and execution checks. Processed keys now have per-user **pair** identity only after accepted order.
4. Migration `029_strategy_reservations_and_exit_policy.sql` creates serialized, database-atomic reservations for BOTH strategies. A PostgreSQL user-row lock serializes per-user capital and count checks. 3 sniper entry reservations/day and 0.03 SOL/day are checked against exact bigint lamports, not floating-point counters. `IN_FLIGHT` outcomes consume quota until reconciled. A database trigger completes a reservation only when an eligible BUY has verified inventory and confirmation evidence, in the same transaction as trade accounting. Strategy and global active position caps are separate. The prior `sniper_states` read-modify-write accounting was removed from code.
5. BUY reservation must succeed before either strategy calls `executeOrder`. Trade creation, fill accounting and signing still use the existing services. Failed/uncertain executions retain reservations if any active BUY OR any trade with a durable transaction signature may exist; operators must reconcile them, not reset counters blindly.
6. Each newly created trade persists an `exit_policy_snapshot`. Sniper's configured TP(+20%)/SL(-10%) results in a full close at the threshold, with Trending's trailing-stop disabled for sniper. Historical sniper positions with no snapshot load sniper settings, not Trending settings.
7. Sniper slippage configuration is passed into TraderService; effective slippage is additionally limited by global MAX_SLIPPAGE_BPS (currently 200 = 2%).
8. `SUBMITTED`/`PENDING` are not falsely labeled confirmed. New Telegram settings buttons edit the **real** sniper config, not legacy `enable_sniper` flags. More independent sniper controls added.
9. Existing native regression guards now pass and specific pure helper tests are included.

## Migration / environment

- **Run migration 029 only AFTER 028** on an ISOLATED TEST database first. Do not replay already-applied migrations, do not modify `022` or `027` to force success, and do not merge historic trades.
- 029 backfills TODAY's prior automated Trending and Sniper attempts into conservative reservation records; it does not change the historic trade or fill ledgers.
- `reserve_strategy_entry` is a SECURITY DEFINER function with EXECUTE revoked from public/anon/authenticated and granted only to `service_role`. Never expose the Supabase service key to Telegram clients.
- For a dry run, execute `scripts/sql/sniper_reservations_integration.sql` on a **disposable DB only**. It uses ROLLBACK, but existing test-user collisions or broken migrations should still be investigated before use.
- Tests requiring actual concurrently executing PostgreSQL sessions, RPC failures, and Solana DevNet are **not included as passed**. Those are release blockers.
- The original `sniper_states` table is kept to preserve existing schema but is not the source of truth for new limits. Historical or in-flight reservations require a deliberate reconciliation procedure.

## Known limitations / blocking issues

- GeckoTerminal polling and the conservative maximum 3 deep-candidate scans per minute can miss very fast launches. The other Trending scanner also consumes API quota; monitor provider 429 responses and implement shared rate limiting before increasing volume. A "new pool" is **not proof of a newly minted token**. The MVP matches pool identity but does not independently verify mint creation age.
- GeckoTerminal, DexScreener and Jupiter data can be late or unavailable; unknown critical security evidence fails closed, potentially rejecting most launches.
- A quote-only simulation is not proof the token can actually be sold later. Ownership concentration/liquidity/rug risk can change instantly.
- Database atomics protect bot entry admission, not executions initiated outside the bot, stale RPC balances, front-running, or Solana transaction ordering.
- Conservative reservations with unresolved on-chain outcomes can block further entries until investigated. **Do not manually release an ambiguous order without chain evidence.**
- Strategy limits for Trending now include a defensive 100 entries/day and 10 SOL/day default. Tune through `AppSettingsSchema` after risk review.
- Global slippage cap remains authoritative; Telegram sniper settings cannot exceed that cap even if their stored value is higher.
- Full `npm ci`, `tsc`, Vitest, PostgreSQL concurrency and DevNet need a working dependency/database/RPC environment before any merge or live usage.

## Review/push

Import files into the existing feature branch `feat/new-token-sniper-dual-autopilot`. Review diff, test in disposable DB, then push the **same feature branch** and open/update its Draft PR. **Never force push or merge automatically.**
