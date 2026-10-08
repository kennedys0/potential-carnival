-- Phase 4: Withdrawal Fixes (P0-01, P0-02)



-- 2. Fix atomic_claim_withdrawal to return JSONB for explicit TS typing (P0-01)
DROP FUNCTION IF EXISTS atomic_claim_withdrawal(UUID, BIGINT);

CREATE OR REPLACE FUNCTION atomic_claim_withdrawal(
    p_id UUID,
    p_user_id BIGINT
) RETURNS JSONB AS $$
DECLARE
    v_record RECORD;
BEGIN
    SELECT * INTO v_record 
    FROM withdrawal_attempts 
    WHERE id = p_id 
    AND user_id = p_user_id 
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('v_attempt', NULL, 'status', 'NOT_FOUND_OR_LOCKED');
    END IF;

    IF v_record.status != 'AUTHORIZED' THEN
        RETURN jsonb_build_object('v_attempt', row_to_json(v_record)::jsonb, 'status', 'ALREADY_CLAIMED_OR_INVALID_STATE');
    END IF;

    UPDATE withdrawal_attempts 
    SET status = 'CLAIMED', updated_at = NOW() 
    WHERE id = v_record.id 
    RETURNING * INTO v_record;

    RETURN jsonb_build_object('v_attempt', row_to_json(v_record)::jsonb, 'status', 'SUCCESS');
END;
$$ LANGUAGE plpgsql;
