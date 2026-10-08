-- Phase 6: Comprehensive Withdrawal Constraint and atomic reservation check
DROP INDEX IF EXISTS unique_active_withdrawal;

-- Prevent multiple active withdrawal attempts per user (any state that is not a terminal state)
CREATE UNIQUE INDEX unique_active_withdrawal 
ON withdrawal_attempts (user_id) 
WHERE status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'RECONCILED', 'UNKNOWN');

-- Atomic creation function with spendable SOL check
CREATE OR REPLACE FUNCTION atomic_create_withdrawal(
    p_user_id BIGINT,
    p_amount_sol NUMERIC,
    p_destination_address TEXT,
    p_idempotency_key TEXT,
    p_spendable_sol NUMERIC
) RETURNS UUID AS $$
DECLARE
    v_active_count INT;
    v_new_id UUID;
BEGIN
    -- Check for existing active withdrawals
    SELECT COUNT(*) INTO v_active_count 
    FROM withdrawal_attempts 
    WHERE user_id = p_user_id 
    AND status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'RECONCILED', 'UNKNOWN');

    IF v_active_count > 0 THEN
        RAISE EXCEPTION 'Withdrawal sedang diproses atau sudah pernah dikirim.';
    END IF;

    -- Spendable SOL check (amount_sol = -1 means MAX)
    IF p_amount_sol != -1 AND p_amount_sol > p_spendable_sol THEN
        RAISE EXCEPTION 'Saldo spendable tidak mencukupi untuk penarikan ini.';
    END IF;

    -- Insert the new attempt
    INSERT INTO withdrawal_attempts (user_id, amount_sol, destination_address, status, idempotency_key)
    VALUES (p_user_id, p_amount_sol, p_destination_address, 'AUTHORIZED', p_idempotency_key)
    RETURNING id INTO v_new_id;

    RETURN v_new_id;
END;
$$ LANGUAGE plpgsql;
