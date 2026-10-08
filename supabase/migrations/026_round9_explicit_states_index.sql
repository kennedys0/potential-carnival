-- Phase 15: Index update for new explicit states
-- Separated from 024 to avoid Postgres 'unsafe use of new value' error
-- which occurs when using a newly added ENUM value in the same transaction block.

DROP INDEX IF EXISTS unique_active_buy_intent;

CREATE UNIQUE INDEX unique_active_buy_intent 
ON trades (user_id, token_mint, is_dry_run) 
WHERE status IN ('RESERVED', 'SIGNED', 'BROADCAST_ATTEMPTED', 'PENDING', 'OPEN', 'PARTIAL_EXIT') AND side = 'BUY';
