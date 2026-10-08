-- Phase 4: Durable Financial Intent for BUYs (P0)
-- Prevent duplicate BUY executions for the same user and token while one is still active.

DROP INDEX IF EXISTS unique_active_buy_intent;

CREATE UNIQUE INDEX unique_active_buy_intent 
ON trades (user_id, token_mint) 
WHERE status IN ('PENDING', 'OPEN', 'PARTIAL_EXIT') AND side = 'BUY';
