-- Abhyas Study Together Phase 1
-- Run once in the Supabase SQL Editor (or apply with the Supabase CLI).
create table public.study_rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  name text not null check (length(trim(name)) between 1 and 80),
  subject text not null check (length(trim(subject)) between 1 and 80),
  host_id uuid not null references auth.users(id) on delete cascade,
  youtube_url text,
  visibility text not null check (visibility in ('public', 'private')),
  max_participants integer not null default 5 check (max_participants between 2 and 10),
  status text not null default 'active' check (status in ('active', 'ended')),
  created_at timestamptz not null default now()
);

create table public.study_room_participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.study_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  joined_at timestamptz not null default now(),
  role text not null check (role in ('host', 'participant')),
  constraint study_room_participants_unique_member unique (room_id, user_id)
);

create index study_rooms_active_public_idx on public.study_rooms (created_at desc) where visibility = 'public' and status = 'active';
create index study_room_participants_room_idx on public.study_room_participants (room_id, joined_at);

alter table public.study_rooms enable row level security;
alter table public.study_room_participants enable row level security;

create or replace function public.is_study_room_participant(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.study_room_participants p
    where p.room_id = p_room_id and p.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_study_room_participant(uuid) from public, anon, authenticated;
grant execute on function public.is_study_room_participant(uuid) to authenticated;

create policy "Authenticated learners can read public or joined rooms"
on public.study_rooms for select to authenticated
using (visibility = 'public' or host_id = (select auth.uid()) or public.is_study_room_participant(id));

create policy "Learners can see participants in rooms they can access"
on public.study_room_participants for select to authenticated
using (
  user_id = (select auth.uid())
  or public.is_study_room_participant(room_id)
  or exists (
    select 1 from public.study_rooms r
    where r.id = room_id and (r.visibility = 'public' or r.host_id = (select auth.uid()))
  )
);

revoke all privileges on table public.study_rooms, public.study_room_participants from public, anon, authenticated;
grant select on public.study_rooms, public.study_room_participants to authenticated;

create or replace function public.create_study_room(
  p_name text,
  p_subject text,
  p_youtube_url text,
  p_visibility text,
  p_max_participants integer,
  p_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room_id uuid;
  v_room_code text;
begin
  if v_user_id is null then raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED'; end if;
  if coalesce(length(trim(p_name)), 0) not between 1 and 80
    or coalesce(length(trim(p_subject)), 0) not between 1 and 80
    or p_visibility is null or p_visibility not in ('public', 'private')
    or p_max_participants not between 2 and 10
    or coalesce(length(trim(p_display_name)), 0) not between 1 and 80
    or (p_youtube_url is not null and p_youtube_url !~* '^https?://(www\.)?(youtube\.com|youtu\.be)/') then
    raise exception using errcode = 'P0001', message = 'INVALID_ROOM';
  end if;

  loop
    v_room_code := pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from public.study_rooms where room_code = v_room_code);
  end loop;

  insert into public.study_rooms (room_code, name, subject, host_id, youtube_url, visibility, max_participants)
  values (v_room_code, trim(p_name), trim(p_subject), v_user_id, nullif(trim(p_youtube_url), ''), p_visibility, p_max_participants)
  returning id into v_room_id;

  insert into public.study_room_participants (room_id, user_id, display_name, role)
  values (v_room_id, v_user_id, trim(p_display_name), 'host');
  return v_room_id;
end;
$$;

create or replace function public.join_study_room(p_room_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.study_rooms%rowtype;
  v_room_id uuid;
begin
  if v_user_id is null then raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED'; end if;
  if coalesce(length(trim(p_display_name)), 0) not between 1 and 80 then
    raise exception using errcode = 'P0001', message = 'INVALID_ROOM';
  end if;

  select * into v_room from public.study_rooms
  where room_code = upper(trim(p_room_code))
  for update;
  if not found then raise exception using errcode = 'P0001', message = 'ROOM_NOT_FOUND'; end if;
  if v_room.status <> 'active' then raise exception using errcode = 'P0001', message = 'ROOM_ENDED'; end if;
  if exists (select 1 from public.study_room_participants where room_id = v_room.id and user_id = v_user_id) then
    raise exception using errcode = 'P0001', message = 'ALREADY_PARTICIPANT';
  end if;
  if (select count(*) from public.study_room_participants where room_id = v_room.id) >= v_room.max_participants then
    raise exception using errcode = 'P0001', message = 'ROOM_FULL';
  end if;

  -- Possession of the unguessable room code is the invitation for private rooms.
  insert into public.study_room_participants (room_id, user_id, display_name, role)
  values (v_room.id, v_user_id, trim(p_display_name), 'participant');
  v_room_id := v_room.id;
  return v_room_id;
end;
$$;

create or replace function public.end_study_room(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED'; end if;
  update public.study_rooms set status = 'ended'
  where id = p_room_id and host_id = auth.uid() and status = 'active';
  if not found then raise exception using errcode = 'P0001', message = 'NOT_ROOM_HOST'; end if;
  return true;
end;
$$;

revoke all on function public.create_study_room(text, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.join_study_room(text, text) from public, anon, authenticated;
revoke all on function public.end_study_room(uuid) from public, anon, authenticated;
grant execute on function public.create_study_room(text, text, text, text, integer, text) to authenticated;
grant execute on function public.join_study_room(text, text) to authenticated;
grant execute on function public.end_study_room(uuid) to authenticated;

-- Ensure PostgREST immediately discovers the newly created RPC functions.
notify pgrst, 'reload schema';
