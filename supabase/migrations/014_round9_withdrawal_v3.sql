-- Phase 3: Withdrawal Engine V3
ALTER TABLE withdrawal_attempts 
DROP CONSTRAINT IF EXISTS withdrawal_attempts_status_check;

ALTER TABLE withdrawal_attempts 
ADD CONSTRAINT withdrawal_attempts_status_check 
CHECK (status IN (
    'CREATED', 'AUTHORIZED', 'CLAIMED', 'SIGNED', 'SUBMITTED', 
    'CONFIRMING', 'TX_CONFIRMED', 'RECONCILING', 'RECONCILED',
    'FAILED', 'EXPIRED', 'UNKNOWN', 'NEEDS_ATTENTION', 'CANCELLED', 'PENDING', 'SUCCESS'
));

CREATE OR REPLACE FUNCTION atomic_claim_withdrawal(
    p_id UUID,
    p_user_id BIGINT
) RETURNS RECORD AS $$
DECLARE
    v_attempt RECORD;
BEGIN
    SELECT * INTO v_attempt 
    FROM withdrawal_attempts 
    WHERE id = p_id 
    AND user_id = p_user_id 
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN (NULL, 'NOT_FOUND_OR_LOCKED');
    END IF;

    IF v_attempt.status != 'AUTHORIZED' THEN
        RETURN (NULL, 'ALREADY_CLAIMED_OR_INVALID_STATE');
    END IF;

    UPDATE withdrawal_attempts 
    SET status = 'CLAIMED', updated_at = NOW() 
    WHERE id = v_attempt.id 
    RETURNING * INTO v_attempt;

    RETURN (v_attempt, 'SUCCESS');
END;
$$ LANGUAGE plpgsql;
