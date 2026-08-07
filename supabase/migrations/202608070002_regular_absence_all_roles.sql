drop policy if exists schedule_regular_absences_insert on public.schedule_regular_absences;
create policy schedule_regular_absences_insert on public.schedule_regular_absences for insert to anon, authenticated
with check (
  public.has_section_access('schedule')
  and public.current_profile_id() is not null
  and profile_id = public.current_profile_id()
);

drop policy if exists schedule_regular_absences_update on public.schedule_regular_absences;
create policy schedule_regular_absences_update on public.schedule_regular_absences for update to anon, authenticated
using (
  public.has_section_access('schedule')
  and public.current_profile_id() is not null
  and profile_id = public.current_profile_id()
)
with check (
  public.has_section_access('schedule')
  and public.current_profile_id() is not null
  and profile_id = public.current_profile_id()
);

drop policy if exists schedule_regular_absences_delete on public.schedule_regular_absences;
create policy schedule_regular_absences_delete on public.schedule_regular_absences for delete to anon, authenticated
using (
  public.has_section_access('schedule')
  and public.current_profile_id() is not null
  and profile_id = public.current_profile_id()
);

create or replace function public.set_own_regular_absence(target_series_id uuid, absence_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
begin
  if actor_id is null or not public.has_section_access('schedule') then
    raise exception 'regular_absence_forbidden';
  end if;
  if not exists (select 1 from public.schedule_series where id = target_series_id) then
    raise exception 'schedule_series_not_found';
  end if;

  if nullif(trim(coalesce(absence_reason, '')), '') is null then
    delete from public.schedule_regular_absences
    where series_id = target_series_id and profile_id = actor_id;
  else
    insert into public.schedule_regular_absences (series_id, profile_id, reason, updated_at)
    values (target_series_id, actor_id, left(trim(absence_reason), 500), now())
    on conflict (series_id, profile_id) do update
    set reason = excluded.reason,
        updated_at = now();
  end if;
  return true;
end;
$$;

create or replace function public.get_schedule_participant_names()
returns table(profile_id uuid, profile_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_section_access('schedule') then
    raise exception 'schedule_access_forbidden';
  end if;
  return query
  select profile.id, profile.name
  from public.profiles profile
  where profile.status = 'active'
  order by profile.name;
end;
$$;

revoke all on function public.set_own_regular_absence(uuid, text) from public;
revoke all on function public.get_schedule_participant_names() from public;
grant execute on function public.set_own_regular_absence(uuid, text) to anon, authenticated;
grant execute on function public.get_schedule_participant_names() to anon, authenticated;
