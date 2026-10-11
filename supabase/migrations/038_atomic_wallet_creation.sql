-- A wallet is a financial custody boundary. Creation must be insert-only and
-- atomic: concurrent requests may race, but an existing encrypted key must
-- never be overwritten by a losing candidate.
CREATE OR REPLACE FUNCTION public.get_or_create_user_wallet(
  p_user_id BIGINT,
  p_public_key TEXT,
  p_encrypted_private_key TEXT,
  p_iv TEXT,
  p_auth_tag TEXT
)
RETURNS SETOF public.user_wallets
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '5s'
AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id <= 0 THEN
    RAISE EXCEPTION 'invalid wallet user id' USING ERRCODE = '22023';
  END IF;

  IF p_public_key IS NULL
     OR p_public_key !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_encrypted_private_key IS NULL
     OR octet_length(p_encrypted_private_key) NOT BETWEEN 1 AND 1024
     OR p_iv IS NULL
     OR octet_length(p_iv) NOT BETWEEN 1 AND 128
     OR p_auth_tag IS NULL
     OR octet_length(p_auth_tag) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid encrypted wallet payload' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_wallets (
    user_id,
    public_key,
    encrypted_private_key,
    iv,
    auth_tag
  ) VALUES (
    p_user_id,
    p_public_key,
    p_encrypted_private_key,
    p_iv,
    p_auth_tag
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY
  SELECT wallet.*
  FROM public.user_wallets AS wallet
  WHERE wallet.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_user_wallet(BIGINT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.get_or_create_user_wallet(BIGINT, TEXT, TEXT, TEXT, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.get_or_create_user_wallet(BIGINT, TEXT, TEXT, TEXT, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_or_create_user_wallet(BIGINT, TEXT, TEXT, TEXT, TEXT) TO service_role;
  END IF;
END;
$$;
