-- Phase 4: Database-backed BUY intents
CREATE TABLE IF NOT EXISTS trade_buy_locks (
    user_id BIGINT NOT NULL,
    token_mint TEXT NOT NULL,
    owner_token UUID NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, token_mint)
);

CREATE OR REPLACE FUNCTION acquire_buy_lock(p_user_id BIGINT, p_token_mint TEXT, p_owner_token UUID, p_ttl_seconds INT)
RETURNS BOOLEAN AS $$
DECLARE
    v_locked BOOLEAN;
BEGIN
    -- Delete expired locks
    DELETE FROM trade_buy_locks WHERE expires_at < NOW();

    BEGIN
        INSERT INTO trade_buy_locks (user_id, token_mint, owner_token, expires_at)
        VALUES (p_user_id, p_token_mint, p_owner_token, NOW() + (p_ttl_seconds || ' seconds')::INTERVAL);
        RETURN TRUE;
    EXCEPTION WHEN unique_violation THEN
        RETURN FALSE;
    END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_buy_lock(p_user_id BIGINT, p_token_mint TEXT, p_owner_token UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_deleted BOOLEAN;
BEGIN
    DELETE FROM trade_buy_locks
    WHERE user_id = p_user_id AND token_mint = p_token_mint AND owner_token = p_owner_token;
    
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION verify_buy_lock(p_user_id BIGINT, p_token_mint TEXT, p_owner_token UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_owner UUID;
BEGIN
    -- Delete expired locks to be safe
    DELETE FROM trade_buy_locks WHERE expires_at < NOW();

    SELECT owner_token INTO v_owner
    FROM trade_buy_locks
    WHERE user_id = p_user_id AND token_mint = p_token_mint;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    RETURN v_owner = p_owner_token;
END;
$$ LANGUAGE plpgsql;
