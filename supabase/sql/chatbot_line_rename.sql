-- Applied on 2026-11-18 to the shared Supabase project, ChatBot objects only.
-- One-time schema rename after supabase/sql/line_ai_seven_columns.sql.
-- The original records and ROW LEVEL SECURITY settings are preserved.
BEGIN;
ALTER TABLE public.line_ai_messages RENAME TO "ChatBot_Line_messages";
ALTER TABLE public.line_ai_events RENAME TO "ChatBot_Line_events";
ALTER VIEW public.line_ai_chat_log_sheet RENAME TO "ChatBot_Line_對話紀錄";
ALTER FUNCTION public.line_ai_runtime_secrets() RENAME TO "ChatBot_Line_runtime_secrets";
ALTER SEQUENCE public.line_ai_messages_id_seq RENAME TO "ChatBot_Line_messages_id_seq";
ALTER TABLE public."ChatBot_Line_messages" RENAME CONSTRAINT line_ai_messages_pkey TO "ChatBot_Line_messages_pkey";
ALTER TABLE public."ChatBot_Line_events" RENAME CONSTRAINT line_ai_events_pkey TO "ChatBot_Line_events_pkey";
ALTER INDEX public.line_ai_messages_user_time_idx RENAME TO "ChatBot_Line_messages_user_time_idx";
ALTER INDEX public.line_ai_messages_created_idx RENAME TO "ChatBot_Line_messages_created_idx";
ALTER INDEX public.line_ai_messages_group_history_idx RENAME TO "ChatBot_Line_messages_group_history_idx";
ALTER INDEX public.line_ai_events_received_idx RENAME TO "ChatBot_Line_events_received_idx";
NOTIFY pgrst, 'reload schema';
COMMIT;
-- The deployed ChatBot Edge Function must use new REST table paths and the
-- rpc/ChatBot_Line_runtime_secrets endpoint. No other project tables are modified.
