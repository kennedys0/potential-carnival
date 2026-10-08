CREATE OR REPLACE FUNCTION get_closed_trades_today(p_user_id BIGINT, p_timezone TEXT)
RETURNS SETOF trades AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM trades
    WHERE user_id = p_user_id
      AND status = 'CLOSED'
      AND closed_at >= (NOW() AT TIME ZONE p_timezone)::DATE AT TIME ZONE p_timezone;
END;
$$ LANGUAGE plpgsql;
