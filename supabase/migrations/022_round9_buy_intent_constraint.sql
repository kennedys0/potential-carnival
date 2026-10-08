-- Phase 4: Durable Financial Intent for BUYs (P0)
-- Prevent duplicate BUY executions for the same user and token while one is still active.

-- PRE-MIGRATION AUDIT: Pastikan tidak ada posisi ganda yang sedang aktif.
-- Jika ditemukan, hentikan migrasi (RAISE EXCEPTION). Migrasi indeks finansial 
-- tidak boleh memaksa menutup atau menggabungkan posisi tanpa bukti rekonsiliasi on-chain.
DO $$
DECLARE
    dup_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO dup_count
    FROM (
        SELECT user_id, token_mint, is_dry_run
        FROM trades
        WHERE status IN ('PENDING', 'OPEN', 'PARTIAL_EXIT') AND side = 'BUY'
        GROUP BY user_id, token_mint, is_dry_run
        HAVING COUNT(*) > 1
    ) AS duplicates;

    IF dup_count > 0 THEN
        RAISE EXCEPTION 'PRE-MIGRATION AUDIT FAILED: Found % groups of duplicate active BUY positions. Migration aborted. Please perform manual historical reconciliation based on on-chain evidence before applying the unique index constraint.', dup_count;
    END IF;
END;
$$;

DROP INDEX IF EXISTS unique_active_buy_intent;

-- Tambahkan is_dry_run agar mode Paper dan Live dapat berjalan paralel secara independen
CREATE UNIQUE INDEX unique_active_buy_intent 
ON trades (user_id, token_mint, is_dry_run) 
WHERE status IN ('PENDING', 'OPEN', 'PARTIAL_EXIT') AND side = 'BUY';
