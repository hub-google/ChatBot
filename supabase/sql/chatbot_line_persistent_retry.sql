-- ChatBot LINE latest-message-wins persistent retry queue.
-- Only operational metadata is stored here; message text stays in ChatBot_Line_對話紀錄.
CREATE TABLE IF NOT EXISTS public."ChatBot_Line_pending" (
  user_hash text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1,
  event_id text NOT NULL,
  latest_message_id bigint NOT NULL,
  latest_event_at timestamptz NOT NULL,
  reply_token text NOT NULL,
  target_id text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('user','group','room')),
  queued_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','sending','sent','uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  leased_until timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS chatbot_line_pending_due_idx
  ON public."ChatBot_Line_pending"(next_retry_at)
  WHERE status='pending';
ALTER TABLE public."ChatBot_Line_pending" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ChatBot_Line_pending" FROM PUBLIC, anon, authenticated;
GRANT ALL ON public."ChatBot_Line_pending" TO service_role;

CREATE OR REPLACE FUNCTION public."ChatBot_Line_enqueue"(
  p_user_hash text, p_event_id text, p_message_id bigint,
  p_event_at timestamptz, p_reply_token text, p_target_id text, p_target_type text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE rev bigint;
BEGIN
  INSERT INTO public."ChatBot_Line_pending" AS t
    (user_hash,revision,event_id,latest_message_id,latest_event_at,reply_token,target_id,target_type)
  VALUES (p_user_hash,1,p_event_id,p_message_id,p_event_at,p_reply_token,p_target_id,p_target_type)
  ON CONFLICT (user_hash) DO UPDATE
  SET revision=t.revision+1, event_id=EXCLUDED.event_id,
      latest_message_id=EXCLUDED.latest_message_id,
      latest_event_at=EXCLUDED.latest_event_at,
      reply_token=EXCLUDED.reply_token, target_id=EXCLUDED.target_id,
      target_type=EXCLUDED.target_type,
      queued_at=now(), status='pending', attempts=0,
      next_retry_at=now(), lease_id=NULL, leased_until=NULL,
      error_code=NULL, updated_at=now()
  WHERE t.latest_event_at <= EXCLUDED.latest_event_at
  RETURNING revision INTO rev;
  RETURN COALESCE(rev,(SELECT revision FROM public."ChatBot_Line_pending" WHERE user_hash=p_user_hash));
END $$;
REVOKE ALL ON FUNCTION public."ChatBot_Line_enqueue"(text,text,bigint,timestamptz,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."ChatBot_Line_enqueue"(text,text,bigint,timestamptz,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public."ChatBot_Line_claim"(
  p_user_hash text DEFAULT NULL, p_limit integer DEFAULT 4
) RETURNS SETOF public."ChatBot_Line_pending"
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  RETURN QUERY
  WITH to_claim AS (
    SELECT user_hash FROM public."ChatBot_Line_pending"
    WHERE (p_user_hash IS NULL OR user_hash=p_user_hash)
      AND ((status='pending' AND next_retry_at<=now())
        OR (status='processing' AND leased_until<now()))
    ORDER BY next_retry_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit,1),8)
  )
  UPDATE public."ChatBot_Line_pending" AS t
    SET status='processing',lease_id=gen_random_uuid(),
        leased_until=now()+interval '110 seconds',updated_at=now()
  FROM to_claim WHERE t.user_hash=to_claim.user_hash
  RETURNING t.*;
END $$;
REVOKE ALL ON FUNCTION public."ChatBot_Line_claim"(text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."ChatBot_Line_claim"(text,integer) TO service_role;

CREATE TABLE IF NOT EXISTS public."ChatBot_Line_push_reservations" (
  billing_month date PRIMARY KEY,
  reserved integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public."ChatBot_Line_push_reservations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ChatBot_Line_push_reservations" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."ChatBot_Line_push_reservations" TO service_role;
CREATE OR REPLACE FUNCTION public."ChatBot_Line_reserve_push"(p_limit integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE month_key date := date_trunc('month',now() AT TIME ZONE 'Asia/Tokyo')::date;
DECLARE n integer;
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 THEN RETURN false; END IF;
  INSERT INTO public."ChatBot_Line_push_reservations"(billing_month,reserved)
    VALUES (month_key,0) ON CONFLICT DO NOTHING;
  UPDATE public."ChatBot_Line_push_reservations"
  SET reserved=reserved+1,updated_at=now()
  WHERE billing_month=month_key AND reserved<LEAST(p_limit,190)
  RETURNING reserved INTO n;
  RETURN n IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public."ChatBot_Line_reserve_push"(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."ChatBot_Line_reserve_push"(integer) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name='chatbot_line_scheduler_key') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32),'hex'),'chatbot_line_scheduler_key');
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public."ChatBot_Line_scheduler_secret"()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name='chatbot_line_scheduler_key' LIMIT 1
$$;
REVOKE ALL ON FUNCTION public."ChatBot_Line_scheduler_secret"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."ChatBot_Line_scheduler_secret"() TO service_role;