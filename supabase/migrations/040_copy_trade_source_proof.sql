-- Persist the immutable on-chain source of every new copy-trade entry.
-- The unique index prevents the same follower/source transaction from being
-- copied again after a Redis restart, websocket replay, or a closed position.

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS copy_source_signature TEXT,
  ADD COLUMN IF NOT EXISTS copy_target_wallet TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS trades_unique_copy_source
  ON public.trades (user_id, copy_target_wallet, copy_source_signature)
  WHERE strategy = 'COPY_TRADE'
    AND copy_target_wallet IS NOT NULL
    AND copy_source_signature IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_copy_trade_source_proof()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.strategy = 'COPY_TRADE' THEN
    IF NEW.copy_source_signature IS NULL
       OR NEW.copy_source_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'
       OR NEW.copy_target_wallet IS NULL
       OR NEW.copy_target_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN
      RAISE EXCEPTION 'COPY_TRADE requires a valid source signature and target wallet';
    END IF;
  ELSIF NEW.copy_source_signature IS NOT NULL OR NEW.copy_target_wallet IS NOT NULL THEN
    RAISE EXCEPTION 'copy-trade source fields are forbidden for non-copy strategies';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trades_copy_source_proof ON public.trades;
CREATE TRIGGER trades_copy_source_proof
BEFORE INSERT OR UPDATE OF strategy, copy_source_signature, copy_target_wallet
ON public.trades
FOR EACH ROW EXECUTE FUNCTION public.enforce_copy_trade_source_proof();

REVOKE ALL ON FUNCTION public.enforce_copy_trade_source_proof() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN public.trades.copy_source_signature IS
  'Finalized source-wallet transaction signature that authorized a COPY_TRADE entry.';
COMMENT ON COLUMN public.trades.copy_target_wallet IS
  'Watched source wallet whose finalized transaction authorized this COPY_TRADE entry.';
