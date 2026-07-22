create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  email citext not null unique,
  role text not null default 'participant' check (role in ('developer', 'leader', 'teacher', 'admin', 'participant')),
  sections text[] not null default '{}',
  status text not null default 'invited' check (status in ('active', 'invited')),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.sections (
  id text primary key,
  title text not null,
  description text not null default '',
  access_roles text[] not null default '{}',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_files jsonb not null default '[]'::jsonb,
  category text not null,
  category_files jsonb not null default '[]'::jsonb,
  description text not null,
  description_files jsonb not null default '[]'::jsonb,
  author_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  pinned boolean not null default false,
  reactions jsonb not null default '{}'::jsonb,
  comments jsonb not null default '[]'::jsonb,
  deleted_at timestamptz
);

create table if not exists public.hub_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into public.sections (id, title, description, access_roles, sort_order)
values
  ('collection', 'Копилка материалов', 'Ссылки, файлы, идеи и комментарии', array['developer', 'leader', 'teacher', 'admin'], 1),
  ('calendar', 'Календарь репертуара', 'Показы, репетиции и события', array['developer', 'leader', 'teacher', 'admin', 'participant'], 2)
on conflict (id) do update set
  title = excluded.title,
  description = excluded.description,
  access_roles = excluded.access_roles,
  sort_order = excluded.sort_order;

insert into public.profiles (id, name, email, role, sections, status)
values ('00000000-0000-0000-0000-000000000001', 'Андрей Комов', 'a.s.komow@gmail.com', 'developer', array['collection', 'calendar'], 'active')
on conflict (email) do update set
  name = excluded.name,
  role = excluded.role,
  sections = excluded.sections,
  status = excluded.status;

insert into public.hub_settings (key, value)
values ('password_hash', crypt('tam', gen_salt('bf')))
on conflict (key) do nothing;

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where user_id = auth.uid()), 'participant');
$$;

create or replace function public.has_section_access(section_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where user_id = auth.uid()
      and (role in ('developer', 'leader') or section_name = any(sections))
  );
$$;

create or replace function public.check_hub_password(attempt text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.hub_settings
    where key = 'password_hash' and value = crypt(attempt, value)
  );
$$;

create or replace function public.set_hub_password(new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public.current_user_role() not in ('developer', 'leader') then
    raise exception 'insufficient_privilege';
  end if;
  if length(new_password) < 4 then
    raise exception 'password_too_short';
  end if;
  update public.hub_settings
  set value = crypt(new_password, gen_salt('bf')), updated_at = now()
  where key = 'password_hash';
end;
$$;

create or replace function public.trash_material(material_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_user_role() not in ('developer', 'leader', 'teacher', 'admin') then
    raise exception 'insufficient_privilege';
  end if;
  update public.materials set deleted_at = now(), pinned = false where id = material_id;
end;
$$;

create or replace function public.restore_material(material_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_user_role() not in ('developer', 'leader', 'teacher', 'admin') then
    raise exception 'insufficient_privilege';
  end if;
  update public.materials set deleted_at = null where id = material_id;
end;
$$;

create or replace function public.delete_material_forever(material_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_user_role() not in ('developer', 'leader', 'teacher', 'admin') then
    raise exception 'insufficient_privilege';
  end if;
  delete from public.materials where id = material_id;
end;
$$;

create or replace function public.activate_invited_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, name, email, role, sections, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.email,
    'participant',
    '{}',
    'active'
  )
  on conflict (email) do update set
    user_id = excluded.user_id,
    status = 'active',
    name = case when public.profiles.name = '' then excluded.name else public.profiles.name end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.activate_invited_profile();

alter table public.profiles enable row level security;
alter table public.sections enable row level security;
alter table public.materials enable row level security;
alter table public.hub_settings enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
using (user_id = auth.uid() or public.current_user_role() in ('developer', 'leader', 'teacher', 'admin'));

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated
with check (
  public.current_user_role() in ('developer', 'leader')
  or (public.current_user_role() in ('teacher', 'admin') and role = 'participant')
);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
using (public.current_user_role() in ('developer', 'leader'))
with check (public.current_user_role() in ('developer', 'leader'));

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete to authenticated
using (public.current_user_role() in ('developer', 'leader') and id <> '00000000-0000-0000-0000-000000000001');

drop policy if exists sections_select on public.sections;
create policy sections_select on public.sections for select to authenticated using (true);

drop policy if exists sections_insert on public.sections;
create policy sections_insert on public.sections for insert to authenticated
with check (public.current_user_role() in ('developer', 'leader'));

drop policy if exists sections_update on public.sections;
create policy sections_update on public.sections for update to authenticated
using (public.current_user_role() in ('developer', 'leader', 'teacher', 'admin'))
with check (public.current_user_role() in ('developer', 'leader', 'teacher', 'admin'));

drop policy if exists sections_delete on public.sections;
create policy sections_delete on public.sections for delete to authenticated
using (public.current_user_role() in ('developer', 'leader'));

drop policy if exists materials_select on public.materials;
create policy materials_select on public.materials for select to authenticated
using (public.has_section_access('collection'));

drop policy if exists materials_insert on public.materials;
create policy materials_insert on public.materials for insert to authenticated
with check (public.has_section_access('collection'));

drop policy if exists materials_update on public.materials;
create policy materials_update on public.materials for update to authenticated
using (public.has_section_access('collection'))
with check (public.has_section_access('collection'));

revoke all on public.profiles, public.sections, public.materials, public.hub_settings from anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.sections to authenticated;
grant select, insert on public.materials to authenticated;
grant update (source, source_files, category, category_files, description, description_files, pinned, reactions, comments) on public.materials to authenticated;

grant execute on function public.check_hub_password(text) to anon, authenticated;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.has_section_access(text) to authenticated;
grant execute on function public.set_hub_password(text) to authenticated;
grant execute on function public.trash_material(uuid) to authenticated;
grant execute on function public.restore_material(uuid) to authenticated;
grant execute on function public.delete_material_forever(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('materials', 'materials', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists materials_files_select on storage.objects;
create policy materials_files_select on storage.objects for select to authenticated
using (bucket_id = 'materials' and public.has_section_access('collection'));

drop policy if exists materials_files_insert on storage.objects;
create policy materials_files_insert on storage.objects for insert to authenticated
with check (bucket_id = 'materials' and public.has_section_access('collection'));

drop policy if exists materials_files_update on storage.objects;
create policy materials_files_update on storage.objects for update to authenticated
using (bucket_id = 'materials' and public.has_section_access('collection'))
with check (bucket_id = 'materials' and public.has_section_access('collection'));

drop policy if exists materials_files_delete on storage.objects;
create policy materials_files_delete on storage.objects for delete to authenticated
using (bucket_id = 'materials' and public.current_user_role() in ('developer', 'leader', 'teacher', 'admin'));
