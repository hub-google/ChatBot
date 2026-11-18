-- Consolidate the two UI entries created by the earlier migration.
-- This does NOT create a second copy of conversation data.
-- Executed on the shared Supabase project on 2026-11-18.
-- Requires that chatbot_line_rename.sql was already applied.
BEGIN;
DROP VIEW public."ChatBot_Line_對話紀錄";
ALTER TABLE public."ChatBot_Line_messages" RENAME TO "ChatBot_Line_對話紀錄";
ALTER TABLE public."ChatBot_Line_對話紀錄" RENAME COLUMN message_time TO "對話時間";
ALTER TABLE public."ChatBot_Line_對話紀錄" RENAME COLUMN group_name TO "群組名稱";
ALTER TABLE public."ChatBot_Line_對話紀錄" RENAME COLUMN group_uuid TO "群組 UUID";
ALTER TABLE public."ChatBot_Line_對話紀錄" RENAME COLUMN sender_name TO "發送者暱稱";
ALTER TABLE public."ChatBot_Line_對話紀錄" RENAME COLUMN sender_uuid TO "發送者 UUID";
ALTER TABLE public."ChatBot_Line_對話紀錄" RENAME COLUMN content TO "對話內容";
ALTER TABLE public."ChatBot_Line_對話紀錄" RENAME COLUMN ai_model TO "AI 模型";
NOTIFY pgrst, 'reload schema';
COMMIT;

-- Retain id, role, user_hash and created_at for chatbot memory / rate limits.
-- Keep public."ChatBot_Line_events" separate for webhook deduplication.
-- Supabase RLS and existing permissions are preserved by the table rename.
