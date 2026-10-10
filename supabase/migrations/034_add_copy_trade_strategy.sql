-- Forward-only enum extension. Keep this isolated so the value is committed
-- before later migrations use it in functions, rows, or constraints.
ALTER TYPE public.trading_strategy ADD VALUE IF NOT EXISTS 'COPY_TRADE';
