-- Repair only the create RPC. Run only after verify_study_rooms.sql confirms
-- both tables exist and their columns match this migration's expected schema.
-- Run from Supabase Dashboard → SQL Editor as the project owner.
do $$
begin
  if to_regclass('public.study_rooms') is null
    or to_regclass('public.study_room_participants') is null then
    raise exception 'Room tables are missing. Apply 202611140001_study_together_rooms.sql instead.';
  end if;
  if exists (
    select required.table_name, required.column_name
    from (values
      ('study_rooms','id','uuid'), ('study_rooms','room_code','text'), ('study_rooms','name','text'),
      ('study_rooms','subject','text'), ('study_rooms','host_id','uuid'), ('study_rooms','youtube_url','text'),
      ('study_rooms','visibility','text'), ('study_rooms','max_participants','int4'),
      ('study_room_participants','room_id','uuid'), ('study_room_participants','user_id','uuid'),
      ('study_room_participants','display_name','text'), ('study_room_participants','role','text')
    ) as required(table_name, column_name, udt_name)
    left join information_schema.columns c
      on c.table_schema = 'public'
      and c.table_name = required.table_name
      and c.column_name = required.column_name
      and c.udt_name = required.udt_name
    where c.column_name is null
  ) then
    raise exception 'Room tables do not match the expected Abhyas schema. Inspect them before applying a repair.';
  end if;
  if to_regprocedure('public.create_study_room(text,text,text,text,integer,text)') is not null
    and (select proargnames from pg_proc where oid = to_regprocedure('public.create_study_room(text,text,text,text,integer,text)'))
      is distinct from array['p_name','p_subject','p_youtube_url','p_visibility','p_max_participants','p_display_name']::text[] then
    raise exception 'A create_study_room function with the same types but different argument names exists. Inspect it before changing it; PostgreSQL cannot rename input parameters with CREATE OR REPLACE.';
  end if;
end;
$$;

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
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_room_id uuid;
  v_room_code text;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;
  if coalesce(length(trim(p_name)), 0) not between 1 and 80
    or coalesce(length(trim(p_subject)), 0) not between 1 and 80
    or p_visibility is null or p_visibility not in ('public', 'private')
    or p_max_participants not between 2 and 10
    or coalesce(length(trim(p_display_name)), 0) not between 1 and 80
    or (p_youtube_url is not null and p_youtube_url !~* '^https?://(www\.)?(youtube\.com|youtu\.be)/') then
    raise exception using errcode = 'P0001', message = 'INVALID_ROOM';
  end if;

  loop
    v_room_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from public.study_rooms where room_code = v_room_code);
  end loop;

  insert into public.study_rooms
    (room_code, name, subject, host_id, youtube_url, visibility, max_participants)
  values
    (v_room_code, trim(p_name), trim(p_subject), v_user_id,
     nullif(trim(p_youtube_url), ''), p_visibility, p_max_participants)
  returning id into v_room_id;

  insert into public.study_room_participants
    (room_id, user_id, display_name, role)
  values
    (v_room_id, v_user_id, trim(p_display_name), 'host');

  return v_room_id;
end;
$$;

revoke all on function public.create_study_room(text, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.create_study_room(text, text, text, text, integer, text) to authenticated;
notify pgrst, 'reload schema';
