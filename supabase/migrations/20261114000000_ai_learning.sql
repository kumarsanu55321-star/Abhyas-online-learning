create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_lecture_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  video_url text not null,
  transcript text not null,
  materials jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_conversations_user_updated_idx on public.ai_conversations (user_id, updated_at desc);
create index if not exists ai_messages_conversation_created_idx on public.ai_messages (conversation_id, created_at);
create index if not exists ai_lecture_sessions_user_created_idx on public.ai_lecture_sessions (user_id, created_at desc);

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_lecture_sessions enable row level security;

revoke all on public.ai_conversations, public.ai_messages, public.ai_lecture_sessions from anon;
grant select, insert, update, delete on public.ai_conversations, public.ai_messages, public.ai_lecture_sessions to authenticated;

drop policy if exists "Users manage their own AI conversations" on public.ai_conversations;
create policy "Users manage their own AI conversations" on public.ai_conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users manage their own AI messages" on public.ai_messages;
create policy "Users manage their own AI messages" on public.ai_messages
  for all using (
    auth.uid() = user_id and exists (
      select 1 from public.ai_conversations c where c.id = conversation_id and c.user_id = auth.uid()
    )
  ) with check (
    auth.uid() = user_id and exists (
      select 1 from public.ai_conversations c where c.id = conversation_id and c.user_id = auth.uid()
    )
  );
drop policy if exists "Users manage their own AI lecture sessions" on public.ai_lecture_sessions;
create policy "Users manage their own AI lecture sessions" on public.ai_lecture_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
