-- Abhyas Study Together Phase 3: authenticated, room-scoped chat.
-- Apply manually in Supabase SQL Editor. This does not alter existing room,
-- participant, playback, or authentication tables.

create table if not exists public.study_room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.study_rooms(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  message text not null,
  video_timestamp double precision,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint study_room_messages_message_length_check
    check (length(pg_catalog.btrim(message)) between 1 and 2000),
  constraint study_room_messages_video_timestamp_check
    check (video_timestamp is null or (video_timestamp >= 0 and video_timestamp < 86400))
);

-- IF NOT EXISTS avoids a duplicate-table error if the table was already
-- provisioned. Refuse to continue if that existing table has an incompatible
-- shape; review it manually rather than silently relying on an unknown schema.
do $$
declare
  v_columns text[];
begin
  select pg_catalog.array_agg(a.attname::text order by a.attname::text)
  into v_columns
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.study_room_messages'::regclass
    and a.attnum > 0 and not a.attisdropped;

  if v_columns is distinct from array['created_at', 'id', 'message', 'room_id', 'user_id', 'video_timestamp']::text[] then
    raise exception 'public.study_room_messages already exists with an unexpected column set; inspect it before applying the chat migration.';
  end if;

  if exists (
    select 1
    from (values
      ('id', 'uuid'),
      ('room_id', 'uuid'),
      ('user_id', 'uuid'),
      ('message', 'text'),
      ('video_timestamp', 'double precision'),
      ('created_at', 'timestamp with time zone')
    ) expected(column_name, data_type)
    left join information_schema.columns actual
      on actual.table_schema = 'public'
      and actual.table_name = 'study_room_messages'
      and actual.column_name = expected.column_name
    where actual.column_name is null or actual.data_type <> expected.data_type
  ) then
    raise exception 'public.study_room_messages has incompatible column types; inspect it before applying the chat migration.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.study_room_messages'::regclass
      and conname = 'study_room_messages_room_id_fkey' and contype = 'f'
  ) or not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.study_room_messages'::regclass
      and conname = 'study_room_messages_user_id_fkey' and contype = 'f'
  ) then
    raise exception 'public.study_room_messages is missing expected room/user foreign keys; inspect it before applying the chat migration.';
  end if;
end;
$$;

create index if not exists study_room_messages_room_created_idx
  on public.study_room_messages (room_id, created_at, id);

alter table public.study_room_messages enable row level security;

revoke all privileges on table public.study_room_messages from public, anon, authenticated;
grant select on public.study_room_messages to authenticated;
-- The sender column is intentionally omitted from client write privileges;
-- its default is auth.uid(), and the policy checks it against auth.uid().
grant insert (room_id, message, video_timestamp) on public.study_room_messages to authenticated;

do $$
declare
  v_policy pg_catalog.pg_policies%rowtype;
begin
  select * into v_policy from pg_catalog.pg_policies
  where schemaname = 'public' and tablename = 'study_room_messages'
    and policyname = 'Room participants can read chat messages';
  if found and (v_policy.cmd <> 'SELECT'
    or not (v_policy.roles @> array['authenticated']::name[])
    or v_policy.qual not like '%is_study_room_participant%') then
    raise exception 'The existing chat read policy has unexpected permissions; inspect it before applying the chat migration.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'study_room_messages'
      and policyname = 'Room participants can read chat messages'
  ) then
    create policy "Room participants can read chat messages"
      on public.study_room_messages for select to authenticated
      using (public.is_study_room_participant(room_id));
  end if;

  select * into v_policy from pg_catalog.pg_policies
  where schemaname = 'public' and tablename = 'study_room_messages'
    and policyname = 'Active room participants can send chat messages';
  if found and (v_policy.cmd <> 'INSERT'
    or not (v_policy.roles @> array['authenticated']::name[])
    or v_policy.with_check not like '%is_study_room_participant%'
    or v_policy.with_check not like '%auth.uid%'
    or v_policy.with_check not like '%active%') then
    raise exception 'The existing chat insert policy has unexpected permissions; inspect it before applying the chat migration.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'study_room_messages'
      and policyname = 'Active room participants can send chat messages'
  ) then
    create policy "Active room participants can send chat messages"
      on public.study_room_messages for insert to authenticated
      with check (
        user_id = (select auth.uid())
        and public.is_study_room_participant(room_id)
        and exists (
          select 1 from public.study_rooms r
          where r.id = study_room_messages.room_id and r.status = 'active'
        )
      );
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Supabase publication supabase_realtime was not found; enable Realtime for public.study_room_messages before using chat.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'study_room_messages'
  ) then
    execute 'alter publication supabase_realtime add table public.study_room_messages';
  end if;
end;
$$;

notify pgrst, 'reload schema';
