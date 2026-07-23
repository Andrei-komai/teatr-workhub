do $$
declare
  old_schedule_id text;
begin
  select id into old_schedule_id
  from public.sections
  where id not in ('collection', 'calendar', 'schedule')
    and title ilike '%расписан%'
  order by sort_order
  limit 1;

  if not exists (select 1 from public.sections where id = 'schedule') then
    if old_schedule_id is not null then
      update public.profiles
      set sections = array_replace(sections, old_schedule_id, 'schedule')
      where old_schedule_id = any(sections);

      update public.sections
      set id = 'schedule', enabled = true
      where id = old_schedule_id;
    else
      insert into public.sections (id, title, description, access_roles, enabled, sort_order)
      values ('schedule', 'Расписание классов и репетиций', 'Дата, время классов, педагоги, направление, отсутствие', array['developer', 'leader'], true, 3);
    end if;
  else
    update public.sections set enabled = true where id = 'schedule';
  end if;
end $$;

create table if not exists public.schedule_entries (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  start_time time not null,
  teacher text not null check (length(trim(teacher)) >= 2),
  class_name text not null check (length(trim(class_name)) >= 2),
  topic text not null default '',
  absence text not null default '',
  author_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists schedule_entries_date_time_idx
  on public.schedule_entries(event_date, start_time);

alter table public.schedule_entries enable row level security;

drop policy if exists schedule_entries_select on public.schedule_entries;
create policy schedule_entries_select on public.schedule_entries for select to anon, authenticated
using (public.has_section_access('schedule'));

drop policy if exists schedule_entries_insert on public.schedule_entries;
create policy schedule_entries_insert on public.schedule_entries for insert to anon, authenticated
with check (public.has_section_access('schedule') and public.can_manage_content() and author_id = public.current_profile_id());

drop policy if exists schedule_entries_update on public.schedule_entries;
create policy schedule_entries_update on public.schedule_entries for update to anon, authenticated
using (public.has_section_access('schedule') and public.can_manage_content())
with check (public.has_section_access('schedule') and public.can_manage_content());

drop policy if exists schedule_entries_delete on public.schedule_entries;
create policy schedule_entries_delete on public.schedule_entries for delete to anon, authenticated
using (public.has_section_access('schedule') and public.can_manage_content());

revoke all on public.schedule_entries from anon, authenticated;
grant select, insert, update, delete on public.schedule_entries to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.schedule_entries;
exception when duplicate_object then
  null;
end $$;
