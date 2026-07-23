create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) >= 2),
  event_type text not null default 'other' check (event_type in ('rehearsal', 'show', 'other')),
  event_date date not null,
  start_time time not null,
  end_time time,
  description text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  author_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time is null or end_time > start_time)
);

create index if not exists calendar_events_date_time_idx
  on public.calendar_events(event_date, start_time);

alter table public.calendar_events enable row level security;

drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select on public.calendar_events for select to anon, authenticated
using (public.current_profile_id() is not null);

drop policy if exists calendar_events_insert on public.calendar_events;
create policy calendar_events_insert on public.calendar_events for insert to anon, authenticated
with check (public.can_manage_content() and author_id = public.current_profile_id());

drop policy if exists calendar_events_update on public.calendar_events;
create policy calendar_events_update on public.calendar_events for update to anon, authenticated
using (public.can_manage_content())
with check (public.can_manage_content());

drop policy if exists calendar_events_delete on public.calendar_events;
create policy calendar_events_delete on public.calendar_events for delete to anon, authenticated
using (public.can_manage_content());

drop policy if exists sections_update on public.sections;
create policy sections_update on public.sections for update to anon, authenticated
using (public.current_user_role() in ('developer', 'leader'))
with check (public.current_user_role() in ('developer', 'leader'));

revoke all on public.calendar_events from anon, authenticated;
grant select, insert, update, delete on public.calendar_events to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('calendar', 'calendar', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists calendar_files_select on storage.objects;
create policy calendar_files_select on storage.objects for select to anon, authenticated
using (bucket_id = 'calendar' and public.current_profile_id() is not null);

drop policy if exists calendar_files_insert on storage.objects;
create policy calendar_files_insert on storage.objects for insert to anon, authenticated
with check (bucket_id = 'calendar' and public.can_manage_content());

drop policy if exists calendar_files_update on storage.objects;
create policy calendar_files_update on storage.objects for update to anon, authenticated
using (bucket_id = 'calendar' and public.can_manage_content())
with check (bucket_id = 'calendar' and public.can_manage_content());

drop policy if exists calendar_files_delete on storage.objects;
create policy calendar_files_delete on storage.objects for delete to anon, authenticated
using (bucket_id = 'calendar' and public.can_manage_content());

do $$
begin
  alter publication supabase_realtime add table public.calendar_events;
exception when duplicate_object then
  null;
end $$;
