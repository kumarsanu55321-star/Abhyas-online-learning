-- Abhyas Study Together Phase 2: host-authoritative playback state.
-- Apply manually in Supabase SQL Editor. This adds one table and one RPC;
-- it does not alter or recreate the Phase 1 room or participant tables.

create table public.study_room_playback (
  room_id uuid primary key references public.study_rooms(id) on delete cascade,
  host_id uuid not null references auth.users(id) on delete cascade,
  video_id text check (video_id is null or video_id ~ '^[A-Za-z0-9_-]{11}$'),
  playback_status text not null default 'paused' check (playback_status in ('playing', 'paused')),
  position_seconds double precision not null default 0 check (position_seconds >= 0 and position_seconds < 86400),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table public.study_room_playback enable row level security;

revoke all privileges on table public.study_room_playback from public, anon, authenticated;
grant select on public.study_room_playback to authenticated;

create policy "Room participants can read shared playback"
on public.study_room_playback for select to authenticated
using (public.is_study_room_participant(room_id));

create or replace function public.update_study_room_playback(
  p_room_id uuid,
  p_video_id text,
  p_playback_status text,
  p_current_time double precision
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room_host_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select r.host_id into v_room_host_id
  from public.study_rooms r
  where r.id = p_room_id and r.status = 'active';

  if not found then
    raise exception using errcode = 'P0001', message = 'ROOM_NOT_FOUND_OR_ENDED';
  end if;
  if v_room_host_id <> v_user_id then
    raise exception using errcode = 'P0001', message = 'NOT_ROOM_HOST';
  end if;
  if p_playback_status is null or p_playback_status not in ('playing', 'paused')
    or p_current_time is null or p_current_time < 0 or p_current_time >= 86400
    or (p_video_id is not null and p_video_id !~ '^[A-Za-z0-9_-]{11}$') then
    raise exception using errcode = 'P0001', message = 'INVALID_PLAYBACK_STATE';
  end if;

  insert into public.study_room_playback
    (room_id, host_id, video_id, playback_status, position_seconds, updated_at)
  values
    (p_room_id, v_user_id, p_video_id, p_playback_status, p_current_time, pg_catalog.clock_timestamp())
  on conflict (room_id) do update
    set host_id = excluded.host_id,
        video_id = excluded.video_id,
        playback_status = excluded.playback_status,
        position_seconds = excluded.position_seconds,
        updated_at = pg_catalog.clock_timestamp();
end;
$$;

revoke all on function public.update_study_room_playback(uuid, text, text, double precision)
  from public, anon, authenticated;
grant execute on function public.update_study_room_playback(uuid, text, text, double precision)
  to authenticated;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Supabase publication supabase_realtime was not found; enable Realtime for public.study_room_playback before using playback sync.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'study_room_playback'
  ) then
    execute 'alter publication supabase_realtime add table public.study_room_playback';
  end if;
end;
$$;

notify pgrst, 'reload schema';
