-- Phase 4: Explicit states for better recovery

ALTER TYPE position_status ADD VALUE IF NOT EXISTS 'RESERVED';
ALTER TYPE position_status ADD VALUE IF NOT EXISTS 'SIGNED';
ALTER TYPE position_status ADD VALUE IF NOT EXISTS 'BROADCAST_ATTEMPTED';

DROP INDEX IF EXISTS unique_active_buy_intent;

CREATE UNIQUE INDEX unique_active_buy_intent 
ON trades (user_id, token_mint, is_dry_run) 
WHERE status IN ('RESERVED', 'SIGNED', 'BROADCAST_ATTEMPTED', 'PENDING', 'OPEN', 'PARTIAL_EXIT') AND side = 'BUY';
