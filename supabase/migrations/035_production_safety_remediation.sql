-- Production-safety remediation for independent entry/exit attempts and copy trading.

COMMENT ON COLUMN public.trades.pending_signature IS
  'ENTRY transaction signature only. Exit signatures belong exclusively to exit_attempts.tx_signature.';

ALTER TABLE public.exit_attempts
  DROP CONSTRAINT IF EXISTS exit_attempts_status_check;
ALTER TABLE public.exit_attempts
  ADD CONSTRAINT exit_attempts_status_check
  CHECK (status IN ('PENDING','SIGNED','BROADCAST_ATTEMPTED','CONFIRMING','SUCCESS','FAILED'));

DROP INDEX IF EXISTS public.unique_active_exit_attempt;
CREATE UNIQUE INDEX unique_active_exit_attempt
  ON public.exit_attempts (trade_id)
  WHERE status IN ('PENDING','SIGNED','BROADCAST_ATTEMPTED','CONFIRMING');

ALTER TABLE public.copy_trade_targets
  DROP CONSTRAINT IF EXISTS copy_trade_targets_max_buy_usd_check;
ALTER TABLE public.copy_trade_targets
  ADD CONSTRAINT copy_trade_targets_max_buy_usd_check
  CHECK (max_buy_usd > 0 AND max_buy_usd <= 10000);

DROP POLICY IF EXISTS "Users can manage their own copy trade targets"
  ON public.copy_trade_targets;
ALTER TABLE public.copy_trade_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.copy_trade_targets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.copy_trade_targets TO service_role;

CREATE INDEX IF NOT EXISTS copy_trade_targets_active_wallet_idx
  ON public.copy_trade_targets (target_wallet_address, user_id)
  WHERE is_active = TRUE;

-- COPY_TRADE intentionally uses the same server-side reservation RPC and the
-- same autopilot mode/active gate as TRENDING. An active target alone cannot
-- bypass a disabled autopilot or change PAPER/LIVE mode.

REVOKE ALL ON FUNCTION public.reserve_strategy_entry(
  BIGINT,TEXT,public.trading_strategy,BOOLEAN,BIGINT,INT,INT,INT,BIGINT,BIGINT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_strategy_entry(
  BIGINT,TEXT,public.trading_strategy,BOOLEAN,BIGINT,INT,INT,INT,BIGINT,BIGINT
) TO service_role;
