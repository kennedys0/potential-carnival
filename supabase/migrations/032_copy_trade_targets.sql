-- Migration: 032_copy_trade_targets
-- Description: Table to store target wallets for the Copy Trading / Smart Money Tracker feature

CREATE TABLE IF NOT EXISTS public.copy_trade_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
    target_wallet_address TEXT NOT NULL,
    label TEXT,
    max_buy_usd NUMERIC NOT NULL DEFAULT 10,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, target_wallet_address)
);

-- RLS
ALTER TABLE public.copy_trade_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own copy trade targets"
    ON public.copy_trade_targets
    FOR ALL
    USING (auth.uid()::text = user_id::text)
    WITH CHECK (auth.uid()::text = user_id::text);
