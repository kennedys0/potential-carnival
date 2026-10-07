-- Migrasi Round 5 (Siklus hidup posisi)
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS blockhash text,
  ADD COLUMN IF NOT EXISTS last_valid_block_height bigint,
  ADD COLUMN IF NOT EXISTS pending_since timestamptz;

-- Nonaktifkan constraint lama (kalau ada) dan ganti dengan yang baru
-- menggunakan NOT VALID agar data lama yang melanggar (seperti OPEN kosong) tidak diblokir
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_status_remaining_check;

ALTER TABLE trades ADD CONSTRAINT trades_status_remaining_check 
  CHECK (is_dry_run OR status <> 'OPEN' OR remaining_raw > 0) NOT VALID;
