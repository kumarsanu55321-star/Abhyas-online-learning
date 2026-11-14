-- Abhyas Phase 5: profiles, friend requests, friendships, and online presence.
-- Additive only. Does not alter or recreate Study Together tables.
-- Privacy model: this application intentionally provides an authenticated
-- learner directory. Search returns up to 25 matching public profile fields;
-- profile lookup by username is also available to authenticated users. Neither
-- RPC returns email or other auth.users data. Direct profile-table reads remain
-- revoked; these RPCs are the only client path to directory profile fields.

create table if not exists public.abhyas_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (length(pg_catalog.btrim(display_name)) between 1 and 80),
  avatar_url text check (avatar_url is null or avatar_url ~* '^https://'),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

-- Refuse to silently use an incompatible table if it exists in the remote schema.
do $$
declare
  v_columns text[];
  v_actual text[];
begin
  select pg_catalog.array_agg(a.attname::text order by a.attname::text)
    into v_columns
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.abhyas_profiles'::regclass
    and a.attnum > 0 and not a.attisdropped;

  if v_columns is distinct from array['avatar_url', 'created_at', 'display_name', 'user_id', 'username']::text[] then
    raise exception 'public.abhyas_profiles already exists with an unexpected column set; inspect it before applying this migration.';
  end if;

  if exists (
    select 1 from (values
      ('user_id', 'uuid'), ('username', 'text'), ('display_name', 'text'),
      ('avatar_url', 'text'), ('created_at', 'timestamp with time zone')
    ) expected(column_name, data_type)
    left join information_schema.columns actual
      on actual.table_schema = 'public'
      and actual.table_name = 'abhyas_profiles'
      and actual.column_name = expected.column_name
    where actual.column_name is null or actual.data_type <> expected.data_type
  ) then
    raise exception 'public.abhyas_profiles has incompatible column types; inspect it before applying this migration.';
  end if;

  select pg_catalog.array_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable order by c.column_name)
    into v_actual
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'abhyas_profiles';
  if v_actual is distinct from array[
    'avatar_url:text:YES', 'created_at:timestamp with time zone:NO',
    'display_name:text:NO', 'user_id:uuid:NO', 'username:text:NO'
  ]::text[] then
    raise exception 'public.abhyas_profiles has incompatible nullability or extra/missing columns; inspect it before applying this migration.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.abhyas_profiles'::regclass and c.conname = 'abhyas_profiles_pkey' and c.contype = 'p' and c.conkey = array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.abhyas_profiles'::regclass and a.attname = 'user_id')]::smallint[])
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.abhyas_profiles'::regclass and c.conname = 'abhyas_profiles_user_id_fkey' and c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.confdeltype = 'c' and c.conkey = array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.abhyas_profiles'::regclass and a.attname = 'user_id')]::smallint[])
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.abhyas_profiles'::regclass and c.conname = 'abhyas_profiles_username_check' and c.contype = 'c' and pg_catalog.pg_get_constraintdef(c.oid) like '%a-z0-9_%' and pg_catalog.pg_get_constraintdef(c.oid) like '%{3,24}%')
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.abhyas_profiles'::regclass and c.conname = 'abhyas_profiles_display_name_check' and c.contype = 'c' and pg_catalog.pg_get_constraintdef(c.oid) like '%80%' and (pg_catalog.pg_get_constraintdef(c.oid) like '%between 1 and 80%' or (pg_catalog.pg_get_constraintdef(c.oid) like '%>= 1%' and pg_catalog.pg_get_constraintdef(c.oid) like '%<= 80%')))
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.abhyas_profiles'::regclass and c.conname = 'abhyas_profiles_avatar_url_check' and c.contype = 'c' and pg_catalog.pg_get_constraintdef(c.oid) like '%https%') then
    raise exception 'public.abhyas_profiles is missing required primary key, auth foreign key, or validation checks; inspect it before applying this migration.';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies p
    where p.schemaname = 'public' and p.tablename = 'abhyas_profiles'
      and p.policyname <> 'Authenticated users can view public learner profiles'
  ) then
    raise exception 'public.abhyas_profiles has unexpected RLS policies; inspect them before applying this migration.';
  end if;
end;
$$;

create unique index if not exists abhyas_profiles_username_lower_uidx
  on public.abhyas_profiles (pg_catalog.lower(username));

alter table public.abhyas_profiles enable row level security;
revoke all privileges on table public.abhyas_profiles from public, anon, authenticated;
-- Profile data is accessed only through narrowly scoped RPCs below.
drop policy if exists "Authenticated users can view public learner profiles" on public.abhyas_profiles;

do $$
begin
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.abhyas_profiles'::regclass) then
    raise exception 'RLS must be enabled on public.abhyas_profiles.';
  end if;
  if exists (select 1 from pg_catalog.pg_policies p where p.schemaname = 'public' and p.tablename = 'abhyas_profiles') then
    raise exception 'public.abhyas_profiles must have no direct client RLS policies; use the directory RPCs.';
  end if;
end;
$$;

create or replace function public.handle_new_abhyas_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_username text;
  v_avatar text;
begin
  v_name := pg_catalog.left(pg_catalog.btrim(coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    'Learner'
  )), 80);
  if v_name = '' then v_name := 'Learner'; end if;

  v_username := pg_catalog.lower(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  if v_username !~ '^[a-z0-9_]{3,24}$' then
    v_username := pg_catalog.left(
      pg_catalog.regexp_replace(pg_catalog.lower(v_name), '[^a-z0-9]+', '_', 'g'),
      12
    );
    v_username := pg_catalog.btrim(v_username, '_');
    if v_username = '' then v_username := 'learner'; end if;
    v_username := v_username || '_' || pg_catalog.substr(pg_catalog.replace(new.id::text, '-', ''), 1, 10);
  end if;

  v_avatar := coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture');
  if v_avatar is not null and v_avatar !~* '^https://' then v_avatar := null; end if;

  begin
    insert into public.abhyas_profiles (user_id, username, display_name, avatar_url)
    values (new.id, v_username, v_name, v_avatar)
    on conflict (user_id) do nothing;
  exception when unique_violation then
    v_username := 'learner_' || pg_catalog.substr(pg_catalog.replace(new.id::text, '-', ''), 1, 16);
    insert into public.abhyas_profiles (user_id, username, display_name, avatar_url)
    values (new.id, v_username, v_name, v_avatar)
    on conflict (user_id) do nothing;
  end;
  return new;
end;
$$;

revoke all on function public.handle_new_abhyas_profile() from public, anon, authenticated;

do $$
declare
  v_trigger pg_catalog.pg_trigger%rowtype;
begin
  select * into v_trigger
  from pg_catalog.pg_trigger
  where tgrelid = 'auth.users'::regclass
    and tgname = 'on_auth_user_created_abhyas_profile'
    and not tgisinternal;

  if found then
    if v_trigger.tgfoid <> 'public.handle_new_abhyas_profile()'::regprocedure
      or v_trigger.tgtype <> 5 -- row-level AFTER INSERT
      or v_trigger.tgconstraint <> 0
      or v_trigger.tgqual is not null
      or v_trigger.tgnargs <> 0
      or v_trigger.tgenabled not in ('O', 'A') then
      raise exception 'auth.users trigger on_auth_user_created_abhyas_profile exists with an incompatible function, event, timing, condition, or enabled state.';
    end if;
  else
    create trigger on_auth_user_created_abhyas_profile
      after insert on auth.users
      for each row execute function public.handle_new_abhyas_profile();
  end if;
end;
$$;

-- Backfill existing accounts without reading or exposing email addresses.
insert into public.abhyas_profiles (user_id, username, display_name, avatar_url)
select
  u.id,
  'learner_' || pg_catalog.substr(pg_catalog.replace(u.id::text, '-', ''), 1, 16),
  coalesce(nullif(pg_catalog.left(pg_catalog.btrim(coalesce(
    u.raw_user_meta_data ->> 'full_name',
    u.raw_user_meta_data ->> 'name',
    'Learner'
  )), 80), ''), 'Learner'),
  case
    when coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture') ~* '^https://'
      then coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture')
    else null
  end
from auth.users u
on conflict (user_id) do nothing;

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint friend_requests_not_self check (sender_id <> receiver_id)
);

create table if not exists public.friendships (
  user_low_id uuid not null references auth.users(id) on delete cascade,
  user_high_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_low_id, user_high_id),
  constraint friendships_canonical_pair check (user_low_id < user_high_id)
);

-- Fail before adding indexes or functions if an existing table only partially
-- matches the expected schema. The checks validate exact columns, types,
-- nullability, primary keys, foreign keys, and required check constraints.
do $$
declare
  v_actual text[];
begin
  select pg_catalog.array_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable order by c.column_name)
    into v_actual
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'friend_requests';
  if v_actual is distinct from array[
    'created_at:timestamp with time zone:NO', 'id:uuid:NO', 'receiver_id:uuid:NO',
    'sender_id:uuid:NO', 'status:text:NO', 'updated_at:timestamp with time zone:NO'
  ]::text[] then
    raise exception 'public.friend_requests has an incompatible column layout; inspect it before applying this migration.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.friend_requests'::regclass and c.conname = 'friend_requests_pkey' and c.contype = 'p' and c.conkey = array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.friend_requests'::regclass and a.attname = 'id')]::smallint[])
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.friend_requests'::regclass and c.conname = 'friend_requests_sender_id_fkey' and c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.confdeltype = 'c' and c.conkey = array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.friend_requests'::regclass and a.attname = 'sender_id')]::smallint[])
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.friend_requests'::regclass and c.conname = 'friend_requests_receiver_id_fkey' and c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.confdeltype = 'c' and c.conkey = array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.friend_requests'::regclass and a.attname = 'receiver_id')]::smallint[])
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.friend_requests'::regclass and c.conname = 'friend_requests_not_self' and c.contype = 'c' and pg_catalog.pg_get_constraintdef(c.oid) like '%sender_id <> receiver_id%')
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.friend_requests'::regclass and c.conname = 'friend_requests_status_check' and c.contype = 'c' and pg_catalog.pg_get_constraintdef(c.oid) like '%pending%' and pg_catalog.pg_get_constraintdef(c.oid) like '%accepted%' and pg_catalog.pg_get_constraintdef(c.oid) like '%rejected%' and pg_catalog.pg_get_constraintdef(c.oid) like '%cancelled%') then
    raise exception 'public.friend_requests is missing required primary key, auth foreign keys, or checks; inspect it before applying this migration.';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies p
    where p.schemaname = 'public' and p.tablename = 'friend_requests'
      and p.policyname <> 'Users can read their own friend requests'
  ) then raise exception 'public.friend_requests has unexpected RLS policies; inspect them before applying this migration.'; end if;

  select pg_catalog.array_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable order by c.column_name)
    into v_actual
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'friendships';
  if v_actual is distinct from array[
    'created_at:timestamp with time zone:NO', 'user_high_id:uuid:NO', 'user_low_id:uuid:NO'
  ]::text[] then
    raise exception 'public.friendships has an incompatible column layout; inspect it before applying this migration.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.friendships'::regclass and c.conname = 'friendships_pkey' and c.contype = 'p' and c.conkey = array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.friendships'::regclass and a.attname = 'user_low_id'), (select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.friendships'::regclass and a.attname = 'user_high_id')]::smallint[])
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.friendships'::regclass and c.conname = 'friendships_user_low_id_fkey' and c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.confdeltype = 'c' and c.conkey = array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.friendships'::regclass and a.attname = 'user_low_id')]::smallint[])
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.friendships'::regclass and c.conname = 'friendships_user_high_id_fkey' and c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.confdeltype = 'c' and c.conkey = array[(select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.friendships'::regclass and a.attname = 'user_high_id')]::smallint[])
    or not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.friendships'::regclass and c.conname = 'friendships_canonical_pair' and c.contype = 'c' and pg_catalog.pg_get_constraintdef(c.oid) like '%user_low_id < user_high_id%') then
    raise exception 'public.friendships is missing required primary key, auth foreign keys, or canonical-pair check; inspect it before applying this migration.';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies p
    where p.schemaname = 'public' and p.tablename = 'friendships'
      and p.policyname <> 'Users can read their own friendships'
  ) then raise exception 'public.friendships has unexpected RLS policies; inspect them before applying this migration.'; end if;
end;
$$;

create index if not exists friend_requests_receiver_pending_idx
  on public.friend_requests (receiver_id, created_at desc) where status = 'pending';
create index if not exists friend_requests_sender_pending_idx
  on public.friend_requests (sender_id, created_at desc) where status = 'pending';
create unique index if not exists friend_requests_one_pending_pair_uidx
  on public.friend_requests (least(sender_id, receiver_id), greatest(sender_id, receiver_id))
  where status = 'pending';
create index if not exists friendships_high_user_idx on public.friendships (user_high_id, user_low_id);

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
revoke all privileges on table public.friend_requests, public.friendships from public, anon, authenticated;
grant select on public.friend_requests, public.friendships to authenticated;

do $$
begin
  drop policy if exists "Users can read their own friend requests" on public.friend_requests;
  drop policy if exists "Users can read their own friendships" on public.friendships;
  create policy "Users can read their own friend requests"
    on public.friend_requests for select to authenticated
    using (sender_id = (select auth.uid()) or receiver_id = (select auth.uid()));
  create policy "Users can read their own friendships"
    on public.friendships for select to authenticated
    using (user_low_id = (select auth.uid()) or user_high_id = (select auth.uid()));
end;
$$;

-- Return only profiles related to the caller through a friendship or a pending
-- request. Clients cannot query this table directly.
create or replace function public.get_abhyas_profiles(p_user_ids uuid[])
returns table (user_id uuid, username text, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.username, p.display_name, p.avatar_url
  from public.abhyas_profiles p
  where (select auth.uid()) is not null
    and p.user_id = any(coalesce(p_user_ids, array[]::uuid[]))
    and (
      exists (
        select 1 from public.friendships f
        where (f.user_low_id = (select auth.uid()) and f.user_high_id = p.user_id)
           or (f.user_high_id = (select auth.uid()) and f.user_low_id = p.user_id)
      )
      or exists (
        select 1 from public.friend_requests r
        where r.status = 'pending'
          and ((r.sender_id = (select auth.uid()) and r.receiver_id = p.user_id)
            or (r.receiver_id = (select auth.uid()) and r.sender_id = p.user_id))
      )
    );
$$;

-- A public profile route exposes only the intended profile fields, by username.
create or replace function public.get_public_abhyas_profile(p_username text)
returns table (user_id uuid, username text, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.username, p.display_name, p.avatar_url
  from public.abhyas_profiles p
  where (select auth.uid()) is not null
    and pg_catalog.lower(p.username) = pg_catalog.lower(pg_catalog.btrim(coalesce(p_username, '')))
  limit 1;
$$;

create or replace function public.search_abhyas_profiles(p_query text)
returns table (user_id uuid, username text, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.username, p.display_name, p.avatar_url
  from public.abhyas_profiles p
  where (select auth.uid()) is not null
    and p.user_id <> (select auth.uid())
    and pg_catalog.length(pg_catalog.btrim(coalesce(p_query, ''))) >= 2
    and (
      pg_catalog.strpos(pg_catalog.lower(p.display_name), pg_catalog.lower(pg_catalog.btrim(p_query))) > 0
      or pg_catalog.strpos(pg_catalog.lower(p.username), pg_catalog.lower(pg_catalog.btrim(p_query))) > 0
    )
  order by pg_catalog.lower(p.display_name), pg_catalog.lower(p.username)
  limit 25;
$$;

create or replace function public.create_friend_request(p_receiver_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender_id uuid := auth.uid();
  v_request_id uuid;
begin
  if v_sender_id is null then raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED'; end if;
  if p_receiver_id is null or p_receiver_id = v_sender_id then
    raise exception using errcode = 'P0001', message = 'INVALID_FRIEND_REQUEST';
  end if;
  -- Serialize all operations for this unordered pair, including opposite-side
  -- requests and a concurrent accept/remove. The unique index remains the
  -- database-level backstop if any future code path omits this lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    least(v_sender_id, p_receiver_id)::text || ':' || greatest(v_sender_id, p_receiver_id)::text, 0
  ));
  if not exists (select 1 from public.abhyas_profiles p where p.user_id = p_receiver_id) then
    raise exception using errcode = 'P0001', message = 'USER_NOT_FOUND';
  end if;
  if exists (
    select 1 from public.friendships f
    where f.user_low_id = least(v_sender_id, p_receiver_id)
      and f.user_high_id = greatest(v_sender_id, p_receiver_id)
  ) then
    raise exception using errcode = 'P0001', message = 'ALREADY_FRIENDS';
  end if;
  if exists (
    select 1 from public.friend_requests r
    where r.status = 'pending'
      and ((r.sender_id = v_sender_id and r.receiver_id = p_receiver_id)
        or (r.sender_id = p_receiver_id and r.receiver_id = v_sender_id))
  ) then
    raise exception using errcode = 'P0001', message = 'FRIEND_REQUEST_PENDING';
  end if;

  insert into public.friend_requests (sender_id, receiver_id)
  values (v_sender_id, p_receiver_id)
  returning id into v_request_id;
  return v_request_id;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'FRIEND_REQUEST_PENDING';
end;
$$;

create or replace function public.respond_to_friend_request(p_request_id uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.friend_requests%rowtype;
  v_sender_id uuid;
  v_receiver_id uuid;
begin
  if v_user_id is null then raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED'; end if;
  if p_action is null or p_action not in ('accept', 'reject', 'cancel') then
    raise exception using errcode = 'P0001', message = 'INVALID_FRIEND_REQUEST_ACTION';
  end if;

  -- Read the pair, lock it in the same order as request creation, then lock
  -- and re-read the request row before changing its state.
  select r.sender_id, r.receiver_id into v_sender_id, v_receiver_id
  from public.friend_requests r where r.id = p_request_id;
  if not found then raise exception using errcode = 'P0001', message = 'FRIEND_REQUEST_NOT_PENDING'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    least(v_sender_id, v_receiver_id)::text || ':' || greatest(v_sender_id, v_receiver_id)::text, 0
  ));
  select * into v_request from public.friend_requests where id = p_request_id for update;
  if not found or v_request.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'FRIEND_REQUEST_NOT_PENDING';
  end if;

  if p_action in ('accept', 'reject') then
    if v_request.receiver_id <> v_user_id then
      raise exception using errcode = 'P0001', message = 'ONLY_RECIPIENT_CAN_RESPOND';
    end if;
    if p_action = 'accept' then
      insert into public.friendships (user_low_id, user_high_id)
      values (least(v_request.sender_id, v_request.receiver_id), greatest(v_request.sender_id, v_request.receiver_id))
      on conflict (user_low_id, user_high_id) do nothing;
      update public.friend_requests set status = 'accepted', updated_at = pg_catalog.clock_timestamp() where id = p_request_id;
    else
      update public.friend_requests set status = 'rejected', updated_at = pg_catalog.clock_timestamp() where id = p_request_id;
    end if;
  else
    if v_request.sender_id <> v_user_id then
      raise exception using errcode = 'P0001', message = 'ONLY_SENDER_CAN_CANCEL';
    end if;
    update public.friend_requests set status = 'cancelled', updated_at = pg_catalog.clock_timestamp() where id = p_request_id;
  end if;
end;
$$;

create or replace function public.remove_friend(p_friend_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED'; end if;
  if p_friend_id is null or p_friend_id = v_user_id then
    raise exception using errcode = 'P0001', message = 'INVALID_FRIEND';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    least(v_user_id, p_friend_id)::text || ':' || greatest(v_user_id, p_friend_id)::text, 0
  ));
  delete from public.friendships
  where user_low_id = least(v_user_id, p_friend_id)
    and user_high_id = greatest(v_user_id, p_friend_id);
  if not found then raise exception using errcode = 'P0001', message = 'NOT_FRIENDS'; end if;
end;
$$;

revoke all on function public.search_abhyas_profiles(text) from public, anon, authenticated;
revoke all on function public.get_abhyas_profiles(uuid[]) from public, anon, authenticated;
revoke all on function public.get_public_abhyas_profile(text) from public, anon, authenticated;
revoke all on function public.create_friend_request(uuid) from public, anon, authenticated;
revoke all on function public.respond_to_friend_request(uuid, text) from public, anon, authenticated;
revoke all on function public.remove_friend(uuid) from public, anon, authenticated;
grant execute on function public.search_abhyas_profiles(text) to authenticated;
grant execute on function public.get_abhyas_profiles(uuid[]) to authenticated;
grant execute on function public.get_public_abhyas_profile(text) to authenticated;
grant execute on function public.create_friend_request(uuid) to authenticated;
grant execute on function public.respond_to_friend_request(uuid, text) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;

-- Realtime Presence is ephemeral (no permanent online boolean is stored).
-- Each user publishes only to a topic containing their own auth.uid(). A user
-- may listen to their own topic and their friends' topics, but cannot publish
-- to another user's topic. The frontend maps online state from the authorized
-- topic name rather than trusting a user_id inside a client-supplied payload.
do $$
begin
  drop policy if exists "Authenticated users can read Abhyas presence" on realtime.messages;
  drop policy if exists "Authenticated users can publish Abhyas presence" on realtime.messages;
  drop policy if exists "Abhyas users can read own and friends presence" on realtime.messages;
  drop policy if exists "Abhyas users can publish own presence" on realtime.messages;
  create policy "Abhyas users can read own and friends presence"
    on realtime.messages for select to authenticated
    using (
      extension = 'presence'
      and case
        when (select realtime.topic()) ~ '^abhyas:user-presence:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then (
          substring((select realtime.topic()) from length('abhyas:user-presence:') + 1)::uuid = (select auth.uid())
          or exists (
            select 1 from public.friendships f
            where (f.user_low_id = (select auth.uid()) and f.user_high_id = substring((select realtime.topic()) from length('abhyas:user-presence:') + 1)::uuid)
               or (f.user_high_id = (select auth.uid()) and f.user_low_id = substring((select realtime.topic()) from length('abhyas:user-presence:') + 1)::uuid)
          )
        )
        else false
      end
    );
  create policy "Abhyas users can publish own presence"
    on realtime.messages for insert to authenticated
    with check (
      extension = 'presence'
      and (select realtime.topic()) = 'abhyas:user-presence:' || (select auth.uid())::text
    );
end;
$$;

notify pgrst, 'reload schema';
