-- Abhyas Study Together Phase 4: host-managed playback permissions.
-- Additive migration: preserves existing room/playback tables and the
-- update_study_room_playback(uuid,text,text,double precision) RPC signature.

create table if not exists public.study_room_playback_permissions (
  room_id uuid not null,
  user_id uuid not null,
  can_play_pause boolean not null default false,
  can_seek boolean not null default false,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (room_id, user_id),
  constraint study_room_playback_permissions_member_fkey
    foreign key (room_id, user_id)
    references public.study_room_participants(room_id, user_id)
    on delete cascade
);

-- Guard against silently using an older/incompatible table if one is already
-- present in the remote schema. This migration never drops or recreates it.
do $$
declare
  v_columns text[];
begin
  select pg_catalog.array_agg(a.attname::text order by a.attname::text)
  into v_columns
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.study_room_playback_permissions'::regclass
    and a.attnum > 0 and not a.attisdropped;

  if v_columns is distinct from array['can_play_pause', 'can_seek', 'room_id', 'updated_at', 'user_id']::text[] then
    raise exception 'public.study_room_playback_permissions already exists with an unexpected column set; inspect it before applying this migration.';
  end if;

  if exists (
    select 1
    from (values
      ('room_id', 'uuid'), ('user_id', 'uuid'),
      ('can_play_pause', 'boolean'), ('can_seek', 'boolean'),
      ('updated_at', 'timestamp with time zone')
    ) expected(column_name, data_type)
    left join information_schema.columns actual
      on actual.table_schema = 'public'
      and actual.table_name = 'study_room_playback_permissions'
      and actual.column_name = expected.column_name
    where actual.column_name is null or actual.data_type <> expected.data_type
  ) then
    raise exception 'public.study_room_playback_permissions has incompatible column types; inspect it before applying this migration.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.study_room_playback_permissions'::regclass
      and conname = 'study_room_playback_permissions_pkey' and contype = 'p'
  ) or not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.study_room_playback_permissions'::regclass
      and conname = 'study_room_playback_permissions_member_fkey' and contype = 'f'
  ) then
    raise exception 'public.study_room_playback_permissions is missing expected primary/participant foreign keys; inspect it before applying this migration.';
  end if;
end;
$$;

alter table public.study_room_playback_permissions enable row level security;
revoke all privileges on table public.study_room_playback_permissions from public, anon, authenticated;
grant select on public.study_room_playback_permissions to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'study_room_playback_permissions'
      and policyname = 'Room participants can read playback permissions'
  ) then
    create policy "Room participants can read playback permissions"
      on public.study_room_playback_permissions for select to authenticated
      using (public.is_study_room_participant(room_id));
  end if;
end;
$$;

create or replace function public.manage_study_room_playback_permission(
  p_room_id uuid,
  p_user_id uuid,
  p_can_play_pause boolean,
  p_can_seek boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room_host_id uuid;
  v_room_status text;
  v_target_role text;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;
  if p_user_id is null or p_can_play_pause is null or p_can_seek is null then
    raise exception using errcode = 'P0001', message = 'INVALID_PERMISSION';
  end if;

  select r.host_id, r.status into v_room_host_id, v_room_status
  from public.study_rooms r
  where r.id = p_room_id
  for update;
  if not found or v_room_status <> 'active' then
    raise exception using errcode = 'P0001', message = 'ROOM_NOT_FOUND_OR_ENDED';
  end if;
  if v_room_host_id <> v_user_id then
    raise exception using errcode = 'P0001', message = 'NOT_ROOM_HOST';
  end if;

  select p.role into v_target_role
  from public.study_room_participants p
  where p.room_id = p_room_id and p.user_id = p_user_id;
  if not found or v_target_role <> 'participant' then
    raise exception using errcode = 'P0001', message = 'TARGET_NOT_ROOM_PARTICIPANT';
  end if;

  insert into public.study_room_playback_permissions
    (room_id, user_id, can_play_pause, can_seek, updated_at)
  values (p_room_id, p_user_id, p_can_play_pause, p_can_seek, pg_catalog.clock_timestamp())
  on conflict (room_id, user_id) do update
    set can_play_pause = excluded.can_play_pause,
        can_seek = excluded.can_seek,
        updated_at = pg_catalog.clock_timestamp();
end;
$$;

revoke all on function public.manage_study_room_playback_permission(uuid, uuid, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.manage_study_room_playback_permission(uuid, uuid, boolean, boolean)
  to authenticated;

-- Keep the existing RPC signature. Permission is checked against the
-- authenticated caller and the current room state on every invocation.
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
  v_room_status text;
  v_old_host_id uuid;
  v_old_video_id text;
  v_old_status text;
  v_old_position double precision;
  v_old_updated_at timestamptz;
  v_can_play_pause boolean := false;
  v_can_seek boolean := false;
  v_has_playback boolean := false;
  v_target_position double precision;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  select r.host_id, r.status into v_room_host_id, v_room_status
  from public.study_rooms r
  where r.id = p_room_id
  for update;
  if not found or v_room_status <> 'active' then
    raise exception using errcode = 'P0001', message = 'ROOM_NOT_FOUND_OR_ENDED';
  end if;

  if p_playback_status is null or p_playback_status not in ('playing', 'paused')
    or p_current_time is null or p_current_time < 0 or p_current_time >= 86400
    or (p_video_id is not null and p_video_id !~ '^[A-Za-z0-9_-]{11}$') then
    raise exception using errcode = 'P0001', message = 'INVALID_PLAYBACK_STATE';
  end if;

  select b.host_id, b.video_id, b.playback_status, b.position_seconds, b.updated_at
    into v_old_host_id, v_old_video_id, v_old_status, v_old_position, v_old_updated_at
  from public.study_room_playback b
  where b.room_id = p_room_id
  for update;
  v_has_playback := found;

  if v_user_id = v_room_host_id then
    -- Host retains full control, including initializing playback and changing video.
    v_target_position := p_current_time;
  else
    if not v_has_playback then
      raise exception using errcode = 'P0001', message = 'PLAYBACK_PERMISSION_REQUIRED';
    end if;
    if v_old_host_id <> v_room_host_id then
      raise exception using errcode = 'P0001', message = 'PLAYBACK_STATE_INVALID';
    end if;
    if p_video_id is distinct from v_old_video_id then
      raise exception using errcode = 'P0001', message = 'VIDEO_CHANGE_HOST_ONLY';
    end if;

    select coalesce(perm.can_play_pause, false), coalesce(perm.can_seek, false)
      into v_can_play_pause, v_can_seek
    from public.study_room_playback_permissions perm
    where perm.room_id = p_room_id and perm.user_id = v_user_id;
    v_can_play_pause := coalesce(v_can_play_pause, false);
    v_can_seek := coalesce(v_can_seek, false);

    if p_playback_status is distinct from v_old_status then
      if not v_can_play_pause then
        raise exception using errcode = 'P0001', message = 'PLAY_PAUSE_PERMISSION_REQUIRED';
      end if;
      -- Derive play/pause position from server state; a play-only participant
      -- cannot smuggle a seek timestamp into a status transition.
      v_target_position := v_old_position;
      if v_old_status = 'playing' then
        v_target_position := least(
          86399.0,
          v_old_position + extract(epoch from (v_now - v_old_updated_at))::double precision
        );
      end if;
    else
      if not v_can_seek then
        raise exception using errcode = 'P0001', message = 'SEEK_PERMISSION_REQUIRED';
      end if;
      v_target_position := p_current_time;
    end if;
  end if;

  insert into public.study_room_playback
    (room_id, host_id, video_id, playback_status, position_seconds, updated_at)
  values
    (p_room_id, v_room_host_id, p_video_id, p_playback_status, v_target_position, v_now)
  on conflict (room_id) do update
    set host_id = excluded.host_id,
        video_id = excluded.video_id,
        playback_status = excluded.playback_status,
        position_seconds = excluded.position_seconds,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.update_study_room_playback(uuid, text, text, double precision)
  from public, anon, authenticated;
grant execute on function public.update_study_room_playback(uuid, text, text, double precision)
  to authenticated;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Supabase publication supabase_realtime was not found; enable Realtime for public.study_room_playback_permissions before using playback permissions.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'study_room_playback_permissions'
  ) then
    execute 'alter publication supabase_realtime add table public.study_room_playback_permissions';
  end if;
end;
$$;

notify pgrst, 'reload schema';
