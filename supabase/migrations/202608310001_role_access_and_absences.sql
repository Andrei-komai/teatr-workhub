create or replace function public.can_manage_content()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() in ('developer', 'leader', 'teacher');
$$;

create or replace function public.can_manage_content_plan()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() in ('developer', 'leader', 'teacher', 'admin');
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
    from public.profiles profile
    join public.sections section on section.id = section_name
    where profile.id = public.current_profile_id()
      and (
        profile.role in ('developer', 'leader', 'teacher', 'admin')
        or section_name = any(coalesce(profile.sections, '{}'))
        or (
          profile.role = 'participant'
          and (
            section_name in ('calendar', 'schedule', 'participation-policy')
            or section.title ilike '%хранилищ%'
          )
        )
      )
  );
$$;

-- Раньше копилка автоматически добавлялась каждому новому участнику.
-- Теперь она доступна участнику только по отдельной галочке.
update public.profiles
set sections = array_remove(coalesce(sections, '{}'), 'collection')
where role = 'participant';

create or replace function public.change_hub_password(new_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  raw_token text;
begin
  if public.current_user_role() not in ('developer', 'leader', 'teacher') then
    raise exception 'insufficient_privilege';
  end if;
  if length(new_password) < 4 then
    raise exception 'password_too_short';
  end if;

  update public.hub_settings
  set value = crypt(new_password, gen_salt('bf')), updated_at = now()
  where key = 'password_hash';

  delete from public.hub_access_sessions;
  raw_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.hub_access_sessions(token_hash)
  values (encode(digest(raw_token, 'sha256'), 'hex'));

  return jsonb_build_object('status', 'ok', 'token', raw_token);
end;
$$;

create or replace function public.set_participant_password(target_profile_id uuid, new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor_id uuid := public.current_profile_id();
  target_role text;
begin
  if public.current_user_role() not in ('developer', 'leader', 'teacher') then
    raise exception 'insufficient_privilege';
  end if;
  select role into target_role from public.profiles where id = target_profile_id;
  if target_role is null then raise exception 'profile_not_found'; end if;
  if length(new_password) < 6 then raise exception 'password_too_short'; end if;
  if target_role = 'developer' and actor_id <> target_profile_id then
    raise exception 'insufficient_privilege';
  end if;

  insert into public.profile_credentials(profile_id, password_hash, updated_at)
  values (target_profile_id, crypt(new_password, gen_salt('bf')), now())
  on conflict (profile_id) do update set
    password_hash = excluded.password_hash,
    updated_at = excluded.updated_at;

  delete from public.personal_access_sessions where profile_id = target_profile_id;
end;
$$;

create or replace function public.create_participant_with_password(
  participant_name text,
  participant_email text,
  participant_role text,
  participant_sections text[],
  initial_password text
)
returns public.profiles
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  created_profile public.profiles%rowtype;
  safe_role text;
begin
  if public.current_user_role() not in ('developer', 'leader', 'teacher') then
    raise exception 'insufficient_privilege';
  end if;
  if length(trim(participant_name)) < 2 then raise exception 'invalid_name'; end if;
  if participant_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_email'; end if;
  if length(initial_password) < 6 then raise exception 'password_too_short'; end if;

  safe_role := case
    when participant_role in ('leader', 'teacher', 'admin', 'participant') then participant_role
    else 'participant'
  end;

  insert into public.profiles(name, email, role, sections, status, created_by)
  values (trim(participant_name), trim(participant_email), safe_role, coalesce(participant_sections, '{}'), 'invited', public.current_profile_id())
  returning * into created_profile;

  insert into public.profile_credentials(profile_id, password_hash)
  values (created_profile.id, crypt(initial_password, gen_salt('bf')));
  return created_profile;
exception when unique_violation then
  raise exception 'email_already_exists';
end;
$$;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to anon, authenticated
using (id = public.current_profile_id() or public.current_user_role() in ('developer', 'leader', 'teacher'));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to anon, authenticated
using (public.current_user_role() in ('developer', 'leader', 'teacher'))
with check (public.current_user_role() in ('developer', 'leader', 'teacher'));

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete to anon, authenticated
using (public.current_user_role() in ('developer', 'leader', 'teacher') and id <> '00000000-0000-0000-0000-000000000001');

drop policy if exists sections_insert on public.sections;
create policy sections_insert on public.sections for insert to anon, authenticated
with check (public.current_user_role() in ('developer', 'leader', 'teacher'));

drop policy if exists sections_update on public.sections;
create policy sections_update on public.sections for update to anon, authenticated
using (public.current_user_role() in ('developer', 'leader', 'teacher'))
with check (public.current_user_role() in ('developer', 'leader', 'teacher'));

drop policy if exists sections_delete on public.sections;
create policy sections_delete on public.sections for delete to anon, authenticated
using (public.current_user_role() in ('developer', 'leader', 'teacher'));

drop policy if exists materials_insert on public.materials;
create policy materials_insert on public.materials for insert to anon, authenticated
with check (public.has_section_access('collection') and public.can_manage_content());

drop policy if exists materials_update on public.materials;
create policy materials_update on public.materials for update to anon, authenticated
using (public.has_section_access('collection') and public.can_manage_content())
with check (public.has_section_access('collection') and public.can_manage_content());

drop policy if exists materials_files_insert on storage.objects;
create policy materials_files_insert on storage.objects for insert to anon, authenticated
with check (bucket_id = 'materials' and public.has_section_access('collection') and public.can_manage_content());

drop policy if exists materials_files_update on storage.objects;
create policy materials_files_update on storage.objects for update to anon, authenticated
using (bucket_id = 'materials' and public.has_section_access('collection') and public.can_manage_content())
with check (bucket_id = 'materials' and public.has_section_access('collection') and public.can_manage_content());

drop policy if exists materials_files_delete on storage.objects;
create policy materials_files_delete on storage.objects for delete to anon, authenticated
using (bucket_id = 'materials' and public.has_section_access('collection') and public.can_manage_content());

create or replace function public.trash_material(material_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage_content() then raise exception 'insufficient_privilege'; end if;
  update public.materials set deleted_at = now(), pinned = false where id = material_id;
end;
$$;

create or replace function public.restore_material(material_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage_content() then raise exception 'insufficient_privilege'; end if;
  update public.materials set deleted_at = null where id = material_id;
end;
$$;

create or replace function public.add_material_reaction(material_id uuid, reaction_emoji text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_section_access('collection') or not public.can_manage_content() then raise exception 'insufficient_privilege'; end if;
  if reaction_emoji not in ('❤️', '👍', '🔥', '👏', '😁', '👎') then raise exception 'invalid_reaction'; end if;
  update public.materials
  set reactions = jsonb_set(coalesce(reactions, '{}'::jsonb), array[reaction_emoji], to_jsonb(coalesce((reactions ->> reaction_emoji)::integer, 0) + 1), true)
  where id = material_id and deleted_at is null;
  if not found then raise exception 'material_not_found'; end if;
end;
$$;

create or replace function public.add_material_comment(material_id uuid, comment_text text)
returns void language plpgsql security definer set search_path = public as $$
declare
  actor_name text;
  clean_text text := trim(comment_text);
begin
  if not public.has_section_access('collection') or not public.can_manage_content() then raise exception 'insufficient_privilege'; end if;
  if clean_text is null or clean_text = '' then raise exception 'empty_comment'; end if;
  select name into actor_name from public.profiles where id = public.current_profile_id();
  update public.materials
  set comments = coalesce(comments, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'author', coalesce(actor_name, 'Участник'), 'text', clean_text, 'createdAt', (extract(epoch from clock_timestamp()) * 1000)::bigint))
  where id = material_id and deleted_at is null;
  if not found then raise exception 'material_not_found'; end if;
end;
$$;

drop policy if exists content_plan_items_insert on public.content_plan_items;
create policy content_plan_items_insert on public.content_plan_items for insert to anon, authenticated
with check (public.has_section_access('content-plan') and public.can_manage_content_plan() and author_id = public.current_profile_id());

drop policy if exists content_plan_items_update on public.content_plan_items;
create policy content_plan_items_update on public.content_plan_items for update to anon, authenticated
using (public.has_section_access('content-plan') and public.can_manage_content_plan())
with check (public.has_section_access('content-plan') and public.can_manage_content_plan());

drop policy if exists content_plan_items_delete on public.content_plan_items;
create policy content_plan_items_delete on public.content_plan_items for delete to anon, authenticated
using (public.has_section_access('content-plan') and public.can_manage_content_plan());

drop policy if exists content_plan_files_insert on storage.objects;
create policy content_plan_files_insert on storage.objects for insert to anon, authenticated
with check (bucket_id = 'content-plan' and public.has_section_access('content-plan') and public.can_manage_content_plan());

drop policy if exists content_plan_files_update on storage.objects;
create policy content_plan_files_update on storage.objects for update to anon, authenticated
using (bucket_id = 'content-plan' and public.has_section_access('content-plan') and public.can_manage_content_plan())
with check (bucket_id = 'content-plan' and public.has_section_access('content-plan') and public.can_manage_content_plan());

drop policy if exists content_plan_files_delete on storage.objects;
create policy content_plan_files_delete on storage.objects for delete to anon, authenticated
using (bucket_id = 'content-plan' and public.has_section_access('content-plan') and public.can_manage_content_plan());

drop policy if exists wardrobe_items_insert on public.wardrobe_items;
create policy wardrobe_items_insert on public.wardrobe_items for insert to anon, authenticated
with check (public.has_section_access('wardrobe') and public.can_manage_content() and updated_by = public.current_profile_id());

drop policy if exists wardrobe_items_update on public.wardrobe_items;
create policy wardrobe_items_update on public.wardrobe_items for update to anon, authenticated
using (public.has_section_access('wardrobe') and public.can_manage_content())
with check (public.has_section_access('wardrobe') and public.can_manage_content() and updated_by = public.current_profile_id());

drop policy if exists wardrobe_items_delete on public.wardrobe_items;
create policy wardrobe_items_delete on public.wardrobe_items for delete to anon, authenticated
using (public.has_section_access('wardrobe') and public.can_manage_content());

create table if not exists public.schedule_absences (
  entry_id uuid not null references public.schedule_entries(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null default '' check (length(reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (entry_id, profile_id)
);

alter table public.schedule_absences enable row level security;

drop policy if exists schedule_absences_select on public.schedule_absences;
create policy schedule_absences_select on public.schedule_absences for select to anon, authenticated
using (public.has_section_access('schedule'));

drop policy if exists schedule_absences_insert on public.schedule_absences;
create policy schedule_absences_insert on public.schedule_absences for insert to anon, authenticated
with check (public.has_section_access('schedule') and profile_id = public.current_profile_id());

drop policy if exists schedule_absences_update on public.schedule_absences;
create policy schedule_absences_update on public.schedule_absences for update to anon, authenticated
using (public.has_section_access('schedule') and profile_id = public.current_profile_id())
with check (public.has_section_access('schedule') and profile_id = public.current_profile_id());

drop policy if exists schedule_absences_delete on public.schedule_absences;
create policy schedule_absences_delete on public.schedule_absences for delete to anon, authenticated
using (public.has_section_access('schedule') and profile_id = public.current_profile_id());

revoke all on public.schedule_absences from anon, authenticated;
grant select, insert, update, delete on public.schedule_absences to anon, authenticated;

create or replace function public.set_own_schedule_absence(target_entry_id uuid, absence_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
begin
  if actor_id is null or not public.has_section_access('schedule') then raise exception 'schedule_absence_forbidden'; end if;
  if not exists (select 1 from public.schedule_entries where id = target_entry_id) then raise exception 'schedule_entry_not_found'; end if;

  if nullif(trim(coalesce(absence_reason, '')), '') is null then
    delete from public.schedule_absences where entry_id = target_entry_id and profile_id = actor_id;
  else
    insert into public.schedule_absences(entry_id, profile_id, reason, updated_at)
    values (target_entry_id, actor_id, left(trim(absence_reason), 500), now())
    on conflict (entry_id, profile_id) do update set reason = excluded.reason, updated_at = now();
  end if;
  return true;
end;
$$;

revoke all on function public.can_manage_content_plan() from public;
revoke all on function public.set_own_schedule_absence(uuid, text) from public;
grant execute on function public.can_manage_content_plan() to anon, authenticated;
grant execute on function public.set_own_schedule_absence(uuid, text) to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.schedule_absences;
exception when duplicate_object then null;
end $$;
