-- Phase 4: Durable Financial Intent for BUYs (P0)
-- Prevent duplicate BUY executions for the same user and token while one is still PENDING.

CREATE UNIQUE INDEX IF NOT EXISTS unique_active_buy_intent 
ON trades (user_id, token_mint) 
WHERE status = 'PENDING' AND side = 'BUY';
