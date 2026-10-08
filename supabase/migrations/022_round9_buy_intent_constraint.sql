-- Phase 4: Durable Financial Intent for BUYs (P0)
-- Prevent duplicate BUY executions for the same user and token while one is still active.

-- PRE-MIGRATION AUDIT: Tangani record historis yang sudah terlanjur ganda (duplicate)
-- Jangan dihapus, tapi konsolidasikan (merge) posisinya ke trade yang paling baru agar migrasi indeks berhasil.
DO $$
DECLARE
    dup_group RECORD;
    primary_trade RECORD;
    dup_trade RECORD;
    total_remaining_raw NUMERIC;
    total_token_amount_raw NUMERIC;
    total_sol_spent NUMERIC;
    total_sol NUMERIC;
    total_token NUMERIC;
BEGIN
    FOR dup_group IN 
        SELECT user_id, token_mint, is_dry_run
        FROM trades
        WHERE status IN ('PENDING', 'OPEN', 'PARTIAL_EXIT') AND side = 'BUY'
        GROUP BY user_id, token_mint, is_dry_run
        HAVING COUNT(*) > 1
    LOOP
        -- Ambil trade terbaru sebagai primary position
        SELECT * INTO primary_trade 
        FROM trades 
        WHERE user_id = dup_group.user_id 
          AND token_mint = dup_group.token_mint 
          AND is_dry_run = dup_group.is_dry_run
          AND status IN ('PENDING', 'OPEN', 'PARTIAL_EXIT') 
          AND side = 'BUY'
        ORDER BY created_at DESC 
        LIMIT 1;

        total_remaining_raw := 0;
        total_token_amount_raw := 0;
        total_sol_spent := 0;
        total_sol := 0;
        total_token := 0;

        -- Iterasi duplikat historis yang lebih lama
        FOR dup_trade IN 
            SELECT * FROM trades 
            WHERE user_id = dup_group.user_id 
              AND token_mint = dup_group.token_mint 
              AND is_dry_run = dup_group.is_dry_run
              AND status IN ('PENDING', 'OPEN', 'PARTIAL_EXIT') 
              AND side = 'BUY'
              AND id != primary_trade.id
        LOOP
            total_remaining_raw := total_remaining_raw + COALESCE(NULLIF(dup_trade.remaining_raw, '')::NUMERIC, 0);
            total_token_amount_raw := total_token_amount_raw + COALESCE(NULLIF(dup_trade.token_amount_raw, '')::NUMERIC, 0);
            total_sol_spent := total_sol_spent + COALESCE(NULLIF(dup_trade.sol_spent_lamports, '')::NUMERIC, 0);
            total_sol := total_sol + COALESCE(dup_trade.sol_amount, 0);
            total_token := total_token + COALESCE(dup_trade.token_amount, 0);

            -- Tandai duplikat lama sebagai CLOSED (merged) agar aman dari constraint, tanpa menghapus history
            UPDATE trades 
            SET status = 'CLOSED',
                needs_attention = true,
                failure_reason = 'Legacy duplicate. Inventory merged into trade ' || primary_trade.id,
                remaining_raw = '0',
                closed_at = NOW()
            WHERE id = dup_trade.id;
        END LOOP;

        -- Gabungkan inventaris finansialnya ke primary trade
        UPDATE trades
        SET remaining_raw = (COALESCE(NULLIF(remaining_raw, '')::NUMERIC, 0) + total_remaining_raw)::TEXT,
            token_amount_raw = (COALESCE(NULLIF(token_amount_raw, '')::NUMERIC, 0) + total_token_amount_raw)::TEXT,
            sol_spent_lamports = (COALESCE(NULLIF(sol_spent_lamports, '')::NUMERIC, 0) + total_sol_spent)::TEXT,
            sol_amount = COALESCE(sol_amount, 0) + total_sol,
            token_amount = COALESCE(token_amount, 0) + total_token,
            needs_attention = true,
            failure_reason = 'Consolidated with ' || (SELECT COUNT(*) FROM trades WHERE failure_reason LIKE '% ' || primary_trade.id) || ' legacy duplicate(s)'
        WHERE id = primary_trade.id;

    END LOOP;
END;
$$;

DROP INDEX IF EXISTS unique_active_buy_intent;

-- Tambahkan is_dry_run agar mode Paper dan Live dapat berjalan paralel secara independen
CREATE UNIQUE INDEX unique_active_buy_intent 
ON trades (user_id, token_mint, is_dry_run) 
WHERE status IN ('PENDING', 'OPEN', 'PARTIAL_EXIT') AND side = 'BUY';
