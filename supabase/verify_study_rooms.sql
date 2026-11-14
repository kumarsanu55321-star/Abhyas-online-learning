-- Run in Supabase Dashboard → SQL Editor after applying the room migration.
-- This only reads PostgreSQL catalog metadata.
select
  to_regprocedure('public.create_study_room(text,text,text,text,integer,text)') as create_room_function,
  pg_get_function_arguments(to_regprocedure('public.create_study_room(text,text,text,text,integer,text)')) as create_room_arguments,
  to_regprocedure('public.join_study_room(text,text)') as join_room_function,
  to_regclass('public.study_rooms') as study_rooms_table,
  to_regclass('public.study_room_participants') as participants_table,
  (select relrowsecurity from pg_class where oid = to_regclass('public.study_rooms')) as rooms_rls_enabled,
  (select relrowsecurity from pg_class where oid = to_regclass('public.study_room_participants')) as participants_rls_enabled,
  has_function_privilege(
    'authenticated',
    to_regprocedure('public.create_study_room(text,text,text,text,integer,text)'),
    'execute'
  ) as authenticated_can_create,
  (select prosecdef from pg_proc where oid = to_regprocedure('public.create_study_room(text,text,text,text,integer,text)')) as create_room_is_security_definer;

-- Inspect column names and PostgreSQL types before choosing the repair script.
select table_name, column_name, data_type, udt_name, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('study_rooms', 'study_room_participants')
order by table_name, ordinal_position;
