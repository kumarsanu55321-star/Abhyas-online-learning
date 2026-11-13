-- Additive learning progress and room persistence for authenticated learners.
-- Existing tables and authentication policies are not changed.
create table if not exists public.learner_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  username text not null default '',
  goals jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  show_on_leaderboard boolean not null default false,
  total_xp integer not null default 0 check (total_xp >= 0),
  current_streak integer not null default 0 check (current_streak >= 0),
  best_streak integer not null default 0 check (best_streak >= 0),
  last_activity_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.ensure_learner_profile()
returns public.learner_profiles language plpgsql security definer set search_path = public as $$
declare profile_row public.learner_profiles;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  insert into public.learner_profiles(user_id, display_name, username)
    select u.id, coalesce(nullif(u.raw_user_meta_data->>'full_name',''), split_part(u.email,'@',1)), split_part(u.email,'@',1)
    from auth.users u where u.id = auth.uid()
    on conflict (user_id) do nothing;
  select * into profile_row from public.learner_profiles where user_id = auth.uid();
  return profile_row;
end;
$$;
revoke all on function public.ensure_learner_profile() from public;
grant execute on function public.ensure_learner_profile() to authenticated;

create table if not exists public.learning_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('quiz_completed','reverse_lecture_completed','lecture_analyzed','syllabus_analyzed','study_session_completed','room_joined')),
  title text not null,
  detail text not null default '',
  subject text,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  xp_points integer not null default 0 check (xp_points >= 0),
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists learning_events_user_idempotency_idx on public.learning_events(user_id, idempotency_key) where idempotency_key is not null;
create index if not exists learning_events_user_created_idx on public.learning_events(user_id, created_at desc);

create or replace function public.apply_learning_event_xp()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  points integer;
  activity_day date := (new.created_at at time zone 'UTC')::date;
begin
  points := case new.event_type
    when 'quiz_completed' then 50
    when 'reverse_lecture_completed' then 75
    when 'lecture_analyzed' then 20
    when 'syllabus_analyzed' then 10
    when 'study_session_completed' then least(100, (new.duration_seconds / 60) * 2)
    when 'room_joined' then 0
    else 0 end;
  new.xp_points := points;
  insert into public.learner_profiles(user_id, display_name, username)
    select new.user_id, coalesce(nullif(u.raw_user_meta_data->>'full_name',''), split_part(u.email,'@',1)), split_part(u.email,'@',1)
    from auth.users u where u.id = new.user_id
    on conflict (user_id) do nothing;
  update public.learner_profiles p set
    total_xp = p.total_xp + points,
    current_streak = case
      when p.last_activity_date = activity_day then p.current_streak
      when p.last_activity_date = activity_day - 1 then p.current_streak + 1
      else 1 end,
    best_streak = greatest(p.best_streak, case
      when p.last_activity_date = activity_day then p.current_streak
      when p.last_activity_date = activity_day - 1 then p.current_streak + 1
      else 1 end),
    last_activity_date = activity_day,
    updated_at = now()
  where p.user_id = new.user_id;
  return new;
end;
$$;
drop trigger if exists learning_event_xp_trigger on public.learning_events;
create trigger learning_event_xp_trigger before insert on public.learning_events for each row execute function public.apply_learning_event_xp();

create table if not exists public.study_rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  host_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  subject text not null default '',
  video_url text,
  created_at timestamptz not null default now()
);
create table if not exists public.study_room_members (
  room_id uuid not null references public.study_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create table if not exists public.study_room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.study_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists study_room_messages_room_created_idx on public.study_room_messages(room_id, created_at);

alter table public.learner_profiles enable row level security;
alter table public.learning_events enable row level security;
alter table public.study_rooms enable row level security;
alter table public.study_room_members enable row level security;
alter table public.study_room_messages enable row level security;
grant select on public.learner_profiles to authenticated;
grant update (display_name, username, goals, settings, show_on_leaderboard, updated_at) on public.learner_profiles to authenticated;
grant select, insert on public.learning_events to authenticated;
grant select, insert, update on public.study_rooms to authenticated;
grant select, insert, delete on public.study_room_members to authenticated;
grant select, insert on public.study_room_messages to authenticated;

drop policy if exists "Learners manage own profile" on public.learner_profiles;
create policy "Learners manage own profile" on public.learner_profiles for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Learners read own events" on public.learning_events;
create policy "Learners read own events" on public.learning_events for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Learners add own events" on public.learning_events;
create policy "Learners add own events" on public.learning_events for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Members read rooms" on public.study_rooms;
create policy "Members read rooms" on public.study_rooms for select to authenticated using (exists (select 1 from public.study_room_members m where m.room_id = id and m.user_id = auth.uid()));
drop policy if exists "Authenticated users create rooms" on public.study_rooms;
create policy "Authenticated users create rooms" on public.study_rooms for insert to authenticated with check (auth.uid() = host_user_id);
drop policy if exists "Hosts update rooms" on public.study_rooms;
create policy "Hosts update rooms" on public.study_rooms for update to authenticated using (auth.uid() = host_user_id) with check (auth.uid() = host_user_id);
create or replace function public.is_study_room_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.study_room_members m where m.room_id = p_room_id and m.user_id = auth.uid())
$$;
revoke all on function public.is_study_room_member(uuid) from public;
grant execute on function public.is_study_room_member(uuid) to authenticated;
drop policy if exists "Members read memberships" on public.study_room_members;
create policy "Members read memberships" on public.study_room_members for select to authenticated using (public.is_study_room_member(room_id));
drop policy if exists "Users join themselves" on public.study_room_members;
create policy "Users join themselves" on public.study_room_members for insert to authenticated with check (auth.uid() = user_id and exists (select 1 from public.study_rooms r where r.id = room_id and r.host_user_id = auth.uid()));
drop policy if exists "Users leave themselves" on public.study_room_members;
create policy "Users leave themselves" on public.study_room_members for delete to authenticated using (auth.uid() = user_id);
drop policy if exists "Room members read messages" on public.study_room_messages;
create policy "Room members read messages" on public.study_room_messages for select to authenticated using (public.is_study_room_member(room_id));
drop policy if exists "Room members send messages" on public.study_room_messages;
create policy "Room members send messages" on public.study_room_messages for insert to authenticated with check (auth.uid() = user_id and public.is_study_room_member(room_id));

-- Codes are opaque, high-entropy invite tokens. Joining is performed through this narrow RPC
-- so non-members cannot enumerate private room records.
create or replace function public.join_study_room(p_room_code text)
returns public.study_rooms language plpgsql security definer set search_path = public as $$
declare
  selected_room public.study_rooms;
begin
  select * into selected_room from public.study_rooms where room_code = upper(trim(p_room_code));
  if not found then raise exception 'Room code not found'; end if;
  insert into public.study_room_members(room_id, user_id) values (selected_room.id, auth.uid()) on conflict do nothing;
  return selected_room;
end;
$$;
revoke all on function public.join_study_room(text) from public;
grant execute on function public.join_study_room(text) to authenticated;

create or replace function public.create_study_room(p_room_code text, p_name text, p_subject text default '', p_video_url text default null)
returns public.study_rooms language plpgsql security definer set search_path = public as $$
declare
  created_room public.study_rooms;
begin
  insert into public.study_rooms(room_code, host_user_id, name, subject, video_url)
    values (upper(trim(p_room_code)), auth.uid(), trim(p_name), trim(coalesce(p_subject,'')), nullif(trim(coalesce(p_video_url,'')),''))
    returning * into created_room;
  insert into public.study_room_members(room_id, user_id) values (created_room.id, auth.uid());
  return created_room;
end;
$$;
revoke all on function public.create_study_room(text, text, text, text) from public;
grant execute on function public.create_study_room(text, text, text, text) to authenticated;

create or replace function public.get_learning_leaderboard(p_period text default 'weekly', p_subject text default null)
returns table(user_id uuid, display_name text, username text, total_xp integer, level integer, rank bigint)
language sql stable security definer set search_path = public as $$
  with xp as (
    select p.user_id, p.display_name, p.username,
      case when p_period = 'global' then p.total_xp
        else coalesce(sum(e.xp_points),0)::integer end as score
    from public.learner_profiles p
    left join public.learning_events e on e.user_id = p.user_id
      and (p_period = 'global' or e.created_at >= now() - interval '7 days')
      and (p_subject is null or e.subject = p_subject)
    where p.show_on_leaderboard
    group by p.user_id, p.display_name, p.username, p.total_xp
  )
  select x.user_id, x.display_name, x.username, x.score,
    (x.score / 500) + 1 as level,
    row_number() over (order by x.score desc, x.username) as rank
  from xp x where x.score > 0 order by x.score desc, x.username limit 100
$$;
revoke all on function public.get_learning_leaderboard(text, text) from public;
grant execute on function public.get_learning_leaderboard(text, text) to authenticated;

-- Enable realtime updates for room messages where the standard publication exists.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') and not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'study_room_messages'
  ) then
    alter publication supabase_realtime add table public.study_room_messages;
  end if;
end $$;
