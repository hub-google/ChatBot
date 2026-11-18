-- Cross-platform bridge; do not modify LINE tables
CREATE TABLE IF NOT EXISTS public."ChatBot_Bridge_pairs"(code_hash text PRIMARY KEY CHECK(length(code_hash)=64),expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public."ChatBot_Bridge_devices"(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token_hash text UNIQUE NOT NULL CHECK(length(token_hash)=64),name text NOT NULL DEFAULT 'Chrome',created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz);
CREATE TABLE IF NOT EXISTS public."ChatBot_Bridge_messages"(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,device_id uuid NOT NULL REFERENCES public."ChatBot_Bridge_devices"(id),origin text NOT NULL,conversation_id text NOT NULL,event_id text NOT NULL,role text NOT NULL CHECK(role IN ('user','model')),content text NOT NULL,model text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(device_id,conversation_id,event_id,role));
CREATE INDEX IF NOT EXISTS chatbot_bridge_history_idx ON public."ChatBot_Bridge_messages"(device_id,conversation_id,id DESC);
ALTER TABLE public."ChatBot_Bridge_pairs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ChatBot_Bridge_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ChatBot_Bridge_messages" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ChatBot_Bridge_pairs" FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public."ChatBot_Bridge_devices" FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public."ChatBot_Bridge_messages" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."ChatBot_Bridge_pairs" TO service_role;
GRANT ALL ON public."ChatBot_Bridge_devices" TO service_role;
GRANT ALL ON public."ChatBot_Bridge_messages" TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public."ChatBot_Bridge_messages_id_seq" TO service_role;
CREATE OR REPLACE FUNCTION public."ChatBot_Bridge_redeem"(p_code_hash text,p_token_hash text,p_name text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public."ChatBot_Bridge_pairs"%ROWTYPE; device_uuid uuid;
BEGIN
 IF length(p_code_hash)<>64 OR length(p_token_hash)<>64 THEN RETURN NULL; END IF;
 SELECT * INTO p FROM public."ChatBot_Bridge_pairs" WHERE code_hash=p_code_hash AND used_at IS NULL AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 INSERT INTO public."ChatBot_Bridge_devices"(token_hash,name) VALUES(p_token_hash,left(coalesce(nullif(p_name,''),'Chrome'),100)) RETURNING id INTO device_uuid;
 UPDATE public."ChatBot_Bridge_pairs" SET used_at=now() WHERE code_hash=p_code_hash;
 RETURN device_uuid;
END $$;
REVOKE ALL ON FUNCTION public."ChatBot_Bridge_redeem"(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public."ChatBot_Bridge_redeem"(text,text,text) TO service_role;
