do $$
declare
  old_content_plan_id text;
begin
  select id into old_content_plan_id
  from public.sections
  where id <> 'content-plan'
    and replace(lower(title), 'ё', 'е') ~ 'контент[- ]план'
  order by sort_order
  limit 1;

  if not exists (select 1 from public.sections where id = 'content-plan') then
    if old_content_plan_id is not null then
      update public.profiles
      set sections = array_replace(sections, old_content_plan_id, 'content-plan')
      where old_content_plan_id = any(sections);

      update public.sections
      set id = 'content-plan',
          access_roles = array['developer', 'leader', 'teacher', 'admin'],
          enabled = true
      where id = old_content_plan_id;
    else
      insert into public.sections (id, title, description, access_roles, enabled, sort_order)
      values (
        'content-plan',
        'Контент-план',
        'Публикации, съёмки и разработка контента',
        array['developer', 'leader', 'teacher', 'admin'],
        true,
        6
      );
    end if;
  else
    update public.sections
    set access_roles = array['developer', 'leader', 'teacher', 'admin'],
        enabled = true
    where id = 'content-plan';
  end if;
end $$;

create table if not exists public.content_plan_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('current', 'development')),
  content_date date not null,
  description text not null default '',
  format text not null default '',
  responsible text not null default '',
  link text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  author_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_plan_items_kind_date_idx
  on public.content_plan_items(kind, content_date, created_at);

alter table public.content_plan_items enable row level security;

drop policy if exists content_plan_items_select on public.content_plan_items;
create policy content_plan_items_select on public.content_plan_items for select to anon, authenticated
using (public.has_section_access('content-plan'));

drop policy if exists content_plan_items_insert on public.content_plan_items;
create policy content_plan_items_insert on public.content_plan_items for insert to anon, authenticated
with check (
  public.has_section_access('content-plan')
  and public.can_manage_content()
  and author_id = public.current_profile_id()
);

drop policy if exists content_plan_items_update on public.content_plan_items;
create policy content_plan_items_update on public.content_plan_items for update to anon, authenticated
using (public.has_section_access('content-plan') and public.can_manage_content())
with check (public.has_section_access('content-plan') and public.can_manage_content());

drop policy if exists content_plan_items_delete on public.content_plan_items;
create policy content_plan_items_delete on public.content_plan_items for delete to anon, authenticated
using (public.has_section_access('content-plan') and public.can_manage_content());

revoke all on public.content_plan_items from anon, authenticated;
grant select, insert, update, delete on public.content_plan_items to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('content-plan', 'content-plan', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists content_plan_files_select on storage.objects;
create policy content_plan_files_select on storage.objects for select to anon, authenticated
using (bucket_id = 'content-plan' and public.has_section_access('content-plan'));

drop policy if exists content_plan_files_insert on storage.objects;
create policy content_plan_files_insert on storage.objects for insert to anon, authenticated
with check (bucket_id = 'content-plan' and public.has_section_access('content-plan') and public.can_manage_content());

drop policy if exists content_plan_files_update on storage.objects;
create policy content_plan_files_update on storage.objects for update to anon, authenticated
using (bucket_id = 'content-plan' and public.has_section_access('content-plan') and public.can_manage_content())
with check (bucket_id = 'content-plan' and public.has_section_access('content-plan') and public.can_manage_content());

drop policy if exists content_plan_files_delete on storage.objects;
create policy content_plan_files_delete on storage.objects for delete to anon, authenticated
using (bucket_id = 'content-plan' and public.has_section_access('content-plan') and public.can_manage_content());

do $$
begin
  alter publication supabase_realtime add table public.content_plan_items;
exception when duplicate_object then
  null;
end $$;
