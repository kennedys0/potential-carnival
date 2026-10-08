-- SAFE fresh-install migration: never fabricate fills or close historical positions
-- just to satisfy a new uniqueness constraint.
-- IMPORTANT: If 022 was already applied, changing this file does not undo its effects.
DO $$
DECLARE
    v_duplicates INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_duplicates
    FROM (
        SELECT user_id, token_mint, is_dry_run
        FROM trades
        WHERE side = 'BUY' AND status IN ('PENDING', 'OPEN', 'PARTIAL_EXIT')
        GROUP BY user_id, token_mint, is_dry_run
        HAVING COUNT(*) > 1
    ) duplicate_groups;

    IF v_duplicates > 0 THEN
        RAISE EXCEPTION 'BUY_INTENT_MIGRATION_BLOCKED: % duplicate active-position groups. Reconcile historical positions using verified transaction evidence before applying this migration.', v_duplicates;
    END IF;
END;
$$;

DROP INDEX IF EXISTS unique_active_buy_intent;
CREATE UNIQUE INDEX unique_active_buy_intent
ON trades (user_id, token_mint, is_dry_run)
WHERE side = 'BUY' AND status IN ('PENDING', 'OPEN', 'PARTIAL_EXIT');
