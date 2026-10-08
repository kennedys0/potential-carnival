CREATE TABLE IF NOT EXISTS inventory_discrepancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    token_mint TEXT NOT NULL,
    expected_raw NUMERIC NOT NULL,
    observed_raw NUMERIC NOT NULL,
    difference_raw NUMERIC NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'DETECTED',
    resolution_reason TEXT
);
