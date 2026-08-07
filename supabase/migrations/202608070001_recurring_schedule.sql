create table if not exists public.schedule_series (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time,
  teacher text not null default '',
  class_name text not null default '',
  topic text not null default '',
  author_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (end_time is null or end_time > start_time)
);

create table if not exists public.schedule_holidays (
  holiday_date date primary key,
  title text not null,
  source text not null default ''
);

insert into public.schedule_holidays (holiday_date, title, source)
values
  ('2026-12-31', 'Перенесённый выходной день', 'Постановление Правительства РФ от 24.09.2025 № 1466')
on conflict (holiday_date) do update
set title = excluded.title,
    source = excluded.source;

alter table public.schedule_entries
  drop constraint if exists schedule_entries_teacher_check,
  drop constraint if exists schedule_entries_class_name_check;

alter table public.schedule_entries
  add column if not exists end_time time,
  add column if not exists series_id uuid references public.schedule_series(id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'schedule_entries_end_time_check'
      and conrelid = 'public.schedule_entries'::regclass
  ) then
    alter table public.schedule_entries
      add constraint schedule_entries_end_time_check
      check (end_time is null or end_time > start_time);
  end if;
end
$$;

create index if not exists schedule_entries_series_id_idx
  on public.schedule_entries(series_id);

create table if not exists public.schedule_regular_absences (
  series_id uuid not null references public.schedule_series(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null default '',
  updated_at timestamptz not null default now(),
  primary key (series_id, profile_id)
);

create or replace function public.is_schedule_holiday(check_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    (extract(month from check_date) = 1 and extract(day from check_date) between 1 and 8)
    or to_char(check_date, 'MM-DD') in ('02-23', '03-08', '05-01', '05-09', '06-12', '11-04')
    or exists (
      select 1 from public.schedule_holidays holiday
      where holiday.holiday_date = check_date
    );
$$;

alter table public.schedule_series enable row level security;
alter table public.schedule_holidays enable row level security;
alter table public.schedule_regular_absences enable row level security;

drop policy if exists schedule_series_select on public.schedule_series;
create policy schedule_series_select on public.schedule_series for select to anon, authenticated
using (public.has_section_access('schedule'));

drop policy if exists schedule_series_manage on public.schedule_series;
create policy schedule_series_manage on public.schedule_series for all to anon, authenticated
using (public.has_section_access('schedule') and public.can_manage_content())
with check (public.has_section_access('schedule') and public.can_manage_content());

drop policy if exists schedule_holidays_select on public.schedule_holidays;
create policy schedule_holidays_select on public.schedule_holidays for select to anon, authenticated
using (public.has_section_access('schedule'));

drop policy if exists schedule_holidays_manage on public.schedule_holidays;
create policy schedule_holidays_manage on public.schedule_holidays for all to anon, authenticated
using (public.has_section_access('schedule') and public.can_manage_content())
with check (public.has_section_access('schedule') and public.can_manage_content());

drop policy if exists schedule_regular_absences_select on public.schedule_regular_absences;
create policy schedule_regular_absences_select on public.schedule_regular_absences for select to anon, authenticated
using (public.has_section_access('schedule'));

drop policy if exists schedule_regular_absences_insert on public.schedule_regular_absences;
create policy schedule_regular_absences_insert on public.schedule_regular_absences for insert to anon, authenticated
with check (
  public.has_section_access('schedule')
  and public.current_user_role() = 'participant'
  and profile_id = public.current_profile_id()
);

drop policy if exists schedule_regular_absences_update on public.schedule_regular_absences;
create policy schedule_regular_absences_update on public.schedule_regular_absences for update to anon, authenticated
using (public.current_user_role() = 'participant' and profile_id = public.current_profile_id())
with check (public.current_user_role() = 'participant' and profile_id = public.current_profile_id());

drop policy if exists schedule_regular_absences_delete on public.schedule_regular_absences;
create policy schedule_regular_absences_delete on public.schedule_regular_absences for delete to anon, authenticated
using (public.current_user_role() = 'participant' and profile_id = public.current_profile_id());

revoke all on public.schedule_series, public.schedule_holidays, public.schedule_regular_absences from anon, authenticated;
grant select on public.schedule_series, public.schedule_holidays, public.schedule_regular_absences to anon, authenticated;

create or replace function public.create_schedule_series(
  series_start_date date,
  series_end_date date,
  series_start_time time,
  series_end_time time,
  series_teacher text,
  series_class_name text,
  series_topic text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
  new_series_id uuid;
  created_count integer;
  candidate_count integer;
  expected_end_date date;
begin
  if actor_id is null or not public.can_manage_content() or not public.has_section_access('schedule') then
    raise exception 'schedule_manage_forbidden';
  end if;
  if extract(month from series_start_date) between 8 and 12 then
    expected_end_date := make_date(extract(year from series_start_date)::integer + 1, 1, 31);
  elsif extract(month from series_start_date) between 1 and 6 then
    expected_end_date := make_date(extract(year from series_start_date)::integer, 6, 30);
  else
    raise exception 'invalid_schedule_series_month';
  end if;
  if series_end_date <> expected_end_date then
    raise exception 'invalid_schedule_series_range';
  end if;
  if series_end_time is not null and series_end_time <= series_start_time then
    raise exception 'invalid_schedule_time_range';
  end if;

  insert into public.schedule_series (
    start_date, end_date, weekday, start_time, end_time, teacher, class_name, topic, author_id
  ) values (
    series_start_date,
    series_end_date,
    extract(isodow from series_start_date)::smallint,
    series_start_time,
    series_end_time,
    left(coalesce(trim(series_teacher), ''), 120),
    left(coalesce(trim(series_class_name), ''), 160),
    left(coalesce(trim(series_topic), ''), 1000),
    actor_id
  ) returning id into new_series_id;

  select count(*) into candidate_count
  from generate_series(series_start_date, series_end_date, interval '1 week');

  insert into public.schedule_entries (
    event_date, start_time, end_time, teacher, class_name, topic, absence, author_id, series_id
  )
  select
    day_value::date,
    series_start_time,
    series_end_time,
    left(coalesce(trim(series_teacher), ''), 120),
    left(coalesce(trim(series_class_name), ''), 160),
    left(coalesce(trim(series_topic), ''), 1000),
    '',
    actor_id,
    new_series_id
  from generate_series(series_start_date, series_end_date, interval '1 week') day_value
  where not public.is_schedule_holiday(day_value::date);

  get diagnostics created_count = row_count;
  return jsonb_build_object(
    'series_id', new_series_id,
    'created_count', created_count,
    'skipped_holidays', candidate_count - created_count
  );
end;
$$;

create or replace function public.update_schedule_series(
  target_series_id uuid,
  series_start_time time,
  series_end_time time,
  series_teacher text,
  series_class_name text,
  series_topic text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_content() or not public.has_section_access('schedule') then
    raise exception 'schedule_manage_forbidden';
  end if;
  if series_end_time is not null and series_end_time <= series_start_time then
    raise exception 'invalid_schedule_time_range';
  end if;

  update public.schedule_series
  set start_time = series_start_time,
      end_time = series_end_time,
      teacher = left(coalesce(trim(series_teacher), ''), 120),
      class_name = left(coalesce(trim(series_class_name), ''), 160),
      topic = left(coalesce(trim(series_topic), ''), 1000),
      updated_at = now()
  where id = target_series_id;

  if not found then return false; end if;

  update public.schedule_entries
  set start_time = series_start_time,
      end_time = series_end_time,
      teacher = left(coalesce(trim(series_teacher), ''), 120),
      class_name = left(coalesce(trim(series_class_name), ''), 160),
      topic = left(coalesce(trim(series_topic), ''), 1000),
      updated_at = now()
  where series_id = target_series_id;

  return true;
end;
$$;

create or replace function public.delete_schedule_series(target_series_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  removed_count integer;
begin
  if not public.can_manage_content() or not public.has_section_access('schedule') then
    raise exception 'schedule_manage_forbidden';
  end if;
  delete from public.schedule_series where id = target_series_id;
  get diagnostics removed_count = row_count;
  return removed_count > 0;
end;
$$;

create or replace function public.set_own_regular_absence(target_series_id uuid, absence_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
begin
  if actor_id is null or public.current_user_role() <> 'participant' or not public.has_section_access('schedule') then
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
  where profile.role = 'participant'
    and profile.status = 'active'
  order by profile.name;
end;
$$;

revoke all on function public.is_schedule_holiday(date) from public;
revoke all on function public.create_schedule_series(date, date, time, time, text, text, text) from public;
revoke all on function public.update_schedule_series(uuid, time, time, text, text, text) from public;
revoke all on function public.delete_schedule_series(uuid) from public;
revoke all on function public.set_own_regular_absence(uuid, text) from public;
revoke all on function public.get_schedule_participant_names() from public;

grant execute on function public.is_schedule_holiday(date) to anon, authenticated;
grant execute on function public.create_schedule_series(date, date, time, time, text, text, text) to anon, authenticated;
grant execute on function public.update_schedule_series(uuid, time, time, text, text, text) to anon, authenticated;
grant execute on function public.delete_schedule_series(uuid) to anon, authenticated;
grant execute on function public.set_own_regular_absence(uuid, text) to anon, authenticated;
grant execute on function public.get_schedule_participant_names() to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.schedule_regular_absences;
exception when duplicate_object then null;
end
$$;
