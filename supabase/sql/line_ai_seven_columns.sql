-- Applied to Supabase project unapiwajmgqqtdkixaab on 2026-11-18.
-- Non-destructive: retains all existing line_ai_messages records and their internal IDs.
alter table public.line_ai_messages
  add column if not exists message_time timestamptz,
  add column if not exists group_name text,
  add column if not exists group_uuid text,
  add column if not exists sender_name text,
  add column if not exists sender_uuid text,
  add column if not exists ai_model text;

update public.line_ai_messages
set message_time=created_at
where message_time is null;

alter table public.line_ai_messages alter column message_time set default now();
create index if not exists line_ai_messages_group_history_idx
  on public.line_ai_messages (group_uuid, id desc);

create or replace view public.line_ai_chat_log_sheet
with (security_invoker=true)
as
select
  coalesce(message_time,created_at) as "對話時間",
  group_name as "群組名稱",
  group_uuid as "群組 UUID",
  sender_name as "發送者暱稱",
  sender_uuid as "發送者 UUID",
  content as "對話內容",
  ai_model as "AI 模型"
from public.line_ai_messages
order by id;

alter table public.line_ai_messages enable row level security;
revoke all on public.line_ai_messages from anon,authenticated;
revoke all on public.line_ai_chat_log_sheet from public,anon,authenticated;
grant select,insert,update,delete on public.line_ai_messages to service_role;
grant usage,select on sequence public.line_ai_messages_id_seq to service_role;
grant select on public.line_ai_chat_log_sheet to service_role;
