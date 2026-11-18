-- Separate conversation history for official Telegram/Discord bot channels.
CREATE TABLE IF NOT EXISTS public."ChatBot_Channel_messages" (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL CHECK(channel IN ('telegram','discord')),
  conversation_hash text NOT NULL CHECK(length(conversation_hash)=64),
  event_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('user','model')),
  content text NOT NULL,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel,conversation_hash,event_id,role)
);
CREATE INDEX IF NOT EXISTS chatbot_channel_recent_idx ON public."ChatBot_Channel_messages"(channel,conversation_hash,id DESC);
ALTER TABLE public."ChatBot_Channel_messages" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ChatBot_Channel_messages" FROM PUBLIC,anon,authenticated;
GRANT ALL ON public."ChatBot_Channel_messages" TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public."ChatBot_Channel_messages_id_seq" TO service_role;
