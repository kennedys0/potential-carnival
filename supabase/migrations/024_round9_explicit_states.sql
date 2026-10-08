-- Phase 4: Explicit states for better recovery

ALTER TYPE position_status ADD VALUE IF NOT EXISTS 'RESERVED';
ALTER TYPE position_status ADD VALUE IF NOT EXISTS 'SIGNED';
ALTER TYPE position_status ADD VALUE IF NOT EXISTS 'BROADCAST_ATTEMPTED';
