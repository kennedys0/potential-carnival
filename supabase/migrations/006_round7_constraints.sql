-- Phase 4: Atomic Exit Engine & Double-Sell Prevention
-- Prevent more than one active exit attempt per position at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_exit_attempt ON exit_attempts (trade_id) WHERE status = 'PENDING';
