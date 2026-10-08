-- Phase 4: Trailing stop persistence
ALTER TABLE trades 
ADD COLUMN IF NOT EXISTS highest_pnl_percent NUMERIC DEFAULT 0;
