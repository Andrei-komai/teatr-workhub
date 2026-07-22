create extension if not exists pgcrypto;

create table if not exists public.profile_credentials (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.personal_access_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days')
);

create index if not exists personal_access_sessions_profile_idx
  on public.personal_access_sessions(profile_id);
create index if not exists personal_access_sessions_expiry_idx
  on public.personal_access_sessions(expires_at);

create table if not exists public.personal_login_attempts (
  id bigint generated always as identity primary key,
  email citext not null,
  attempted_at timestamptz not null default now()
);

create index if not exists personal_login_attempts_email_time_idx
  on public.personal_login_attempts(email, attempted_at desc);

revoke all on public.profile_credentials, public.personal_access_sessions, public.personal_login_attempts from anon, authenticated;

create or replace function public.request_personal_token()
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  headers jsonb;
begin
  headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  return nullif(headers ->> 'x-tam-session', '');
exception when others then
  return null;
end;
$$;

create or replace function public.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    (select p.id from public.profiles p where p.user_id = auth.uid()),
    (
      select s.profile_id
      from public.personal_access_sessions s
      where public.request_personal_token() is not null
        and s.token_hash = encode(digest(public.request_personal_token(), 'sha256'), 'hex')
        and s.expires_at > now()
      limit 1
    )
  );
$$;

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = public.current_profile_id()), 'participant');
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
    where id = public.current_profile_id()
      and (role in ('developer', 'leader') or section_name = any(sections))
  );
$$;

create or replace function public.get_current_profile()
returns public.profiles
language sql
stable
security definer
set search_path = public
as $$
  select p from public.profiles p where p.id = public.current_profile_id();
$$;

create or replace function public.login_with_personal_password(login_email text, attempt text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_profile public.profiles%rowtype;
  stored_hash text;
  raw_token text;
  recent_failures integer;
begin
  delete from public.personal_access_sessions where expires_at <= now();
  delete from public.personal_login_attempts where attempted_at < now() - interval '24 hours';

  select p.* into target_profile
  from public.profiles p
  where p.email = trim(login_email)
  limit 1;

  if not found then
    return jsonb_build_object('status', 'email_not_found');
  end if;

  select count(*) into recent_failures
  from public.personal_login_attempts a
  where a.email = target_profile.email
    and a.attempted_at > now() - interval '15 minutes';

  if recent_failures >= 10 then
    return jsonb_build_object('status', 'locked');
  end if;

  select c.password_hash into stored_hash
  from public.profile_credentials c
  where c.profile_id = target_profile.id;

  if stored_hash is null then
    return jsonb_build_object('status', 'password_not_set');
  end if;

  if attempt is null or stored_hash <> crypt(attempt, stored_hash) then
    insert into public.personal_login_attempts(email) values (target_profile.email);
    return jsonb_build_object('status', 'wrong_password');
  end if;

  delete from public.personal_login_attempts where email = target_profile.email;
  raw_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.personal_access_sessions(profile_id, token_hash)
  values (target_profile.id, encode(digest(raw_token, 'sha256'), 'hex'));

  update public.profiles set status = 'active' where id = target_profile.id;

  return jsonb_build_object('status', 'ok', 'token', raw_token);
end;
$$;

create or replace function public.logout_personal_session()
returns void
language sql
security definer
set search_path = public, extensions
as $$
  delete from public.personal_access_sessions
  where public.request_personal_token() is not null
    and token_hash = encode(digest(public.request_personal_token(), 'sha256'), 'hex');
$$;

create or replace function public.set_participant_password(target_profile_id uuid, new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor_id uuid := public.current_profile_id();
  actor_role text := public.current_user_role();
  target_role text;
begin
  select role into target_role from public.profiles where id = target_profile_id;
  if target_role is null then
    raise exception 'profile_not_found';
  end if;
  if length(new_password) < 6 then
    raise exception 'password_too_short';
  end if;
  if actor_role not in ('developer', 'leader', 'teacher', 'admin') then
    raise exception 'insufficient_privilege';
  end if;
  if actor_role in ('teacher', 'admin') and target_role <> 'participant' then
    raise exception 'insufficient_privilege';
  end if;
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
  actor_role text := public.current_user_role();
  created_profile public.profiles%rowtype;
  safe_role text;
begin
  if actor_role not in ('developer', 'leader', 'teacher', 'admin') then
    raise exception 'insufficient_privilege';
  end if;
  if length(trim(participant_name)) < 2 then
    raise exception 'invalid_name';
  end if;
  if participant_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email';
  end if;
  if length(initial_password) < 6 then
    raise exception 'password_too_short';
  end if;

  safe_role := case
    when actor_role in ('developer', 'leader') and participant_role in ('leader', 'teacher', 'admin', 'participant') then participant_role
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
using (id = public.current_profile_id() or public.current_user_role() in ('developer', 'leader', 'teacher', 'admin'));

drop policy if exists profiles_insert on public.profiles;

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to anon, authenticated
using (public.current_user_role() in ('developer', 'leader'))
with check (public.current_user_role() in ('developer', 'leader'));

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete to anon, authenticated
using (public.current_user_role() in ('developer', 'leader') and id <> '00000000-0000-0000-0000-000000000001');

drop policy if exists sections_select on public.sections;
create policy sections_select on public.sections for select to anon, authenticated
using (public.current_profile_id() is not null);

drop policy if exists sections_insert on public.sections;
create policy sections_insert on public.sections for insert to anon, authenticated
with check (public.current_user_role() in ('developer', 'leader'));

drop policy if exists sections_update on public.sections;
create policy sections_update on public.sections for update to anon, authenticated
using (public.current_user_role() in ('developer', 'leader', 'teacher', 'admin'))
with check (public.current_user_role() in ('developer', 'leader', 'teacher', 'admin'));

drop policy if exists sections_delete on public.sections;
create policy sections_delete on public.sections for delete to anon, authenticated
using (public.current_user_role() in ('developer', 'leader'));

drop policy if exists materials_select on public.materials;
create policy materials_select on public.materials for select to anon, authenticated
using (public.has_section_access('collection'));

drop policy if exists materials_insert on public.materials;
create policy materials_insert on public.materials for insert to anon, authenticated
with check (public.has_section_access('collection'));

drop policy if exists materials_update on public.materials;
create policy materials_update on public.materials for update to anon, authenticated
using (public.has_section_access('collection'))
with check (public.has_section_access('collection'));

revoke all on public.profiles, public.sections, public.materials from anon, authenticated;
grant select, update, delete on public.profiles to anon, authenticated;
grant select, insert, update, delete on public.sections to anon, authenticated;
grant select, insert on public.materials to anon, authenticated;
grant update (source, source_files, category, category_files, description, description_files, pinned, reactions, comments) on public.materials to anon, authenticated;

grant execute on function public.request_personal_token() to anon, authenticated;
grant execute on function public.current_profile_id() to anon, authenticated;
grant execute on function public.current_user_role() to anon, authenticated;
grant execute on function public.has_section_access(text) to anon, authenticated;
grant execute on function public.get_current_profile() to anon, authenticated;
grant execute on function public.login_with_personal_password(text, text) to anon, authenticated;
grant execute on function public.logout_personal_session() to anon, authenticated;
grant execute on function public.set_participant_password(uuid, text) to anon, authenticated;
grant execute on function public.create_participant_with_password(text, text, text, text[], text) to anon, authenticated;
grant execute on function public.set_hub_password(text) to anon, authenticated;
grant execute on function public.trash_material(uuid) to anon, authenticated;
grant execute on function public.restore_material(uuid) to anon, authenticated;
grant execute on function public.delete_material_forever(uuid) to anon, authenticated;

drop policy if exists materials_files_select on storage.objects;
create policy materials_files_select on storage.objects for select to anon, authenticated
using (bucket_id = 'materials' and public.has_section_access('collection'));

drop policy if exists materials_files_insert on storage.objects;
create policy materials_files_insert on storage.objects for insert to anon, authenticated
with check (bucket_id = 'materials' and public.has_section_access('collection'));

drop policy if exists materials_files_update on storage.objects;
create policy materials_files_update on storage.objects for update to anon, authenticated
using (bucket_id = 'materials' and public.has_section_access('collection'))
with check (bucket_id = 'materials' and public.has_section_access('collection'));

drop policy if exists materials_files_delete on storage.objects;
create policy materials_files_delete on storage.objects for delete to anon, authenticated
using (bucket_id = 'materials' and public.current_user_role() in ('developer', 'leader', 'teacher', 'admin'));
