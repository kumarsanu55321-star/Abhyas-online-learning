-- Recreate the authenticated, no-argument profile RPC if it is missing from the API schema.
-- Requires public.learner_profiles from 20261115000000_learning_progress_and_rooms.sql.
create or replace function public.ensure_learner_profile()
returns public.learner_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.learner_profiles;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;

  insert into public.learner_profiles(user_id, display_name, username)
    select u.id,
      coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1)),
      split_part(u.email, '@', 1)
    from auth.users u
    where u.id = auth.uid()
    on conflict (user_id) do nothing;

  select * into profile_row
  from public.learner_profiles
  where user_id = auth.uid();

  return profile_row;
end;
$$;

revoke all on function public.ensure_learner_profile() from public;
grant execute on function public.ensure_learner_profile() to authenticated;

notify pgrst, 'reload schema';
