alter table public.profiles
  add column if not exists avatar_path text;

create or replace function public.protect_avatar_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.avatar_path is distinct from old.avatar_path
    and old.id is distinct from public.current_profile_id() then
    raise exception 'avatar_can_only_be_changed_by_owner';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_avatar_ownership on public.profiles;
create trigger protect_avatar_ownership
before update of avatar_path on public.profiles
for each row execute function public.protect_avatar_ownership();

create or replace function public.set_own_avatar(new_avatar_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
begin
  if actor_id is null then
    raise exception 'personal_login_required';
  end if;

  if new_avatar_path is null
    or split_part(new_avatar_path, '/', 1) <> actor_id::text then
    raise exception 'invalid_avatar_path';
  end if;

  update public.profiles
  set avatar_path = new_avatar_path
  where id = actor_id;

  return new_avatar_path;
end;
$$;

revoke all on function public.set_own_avatar(text) from public;
grant execute on function public.set_own_avatar(text) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_select on storage.objects;
create policy avatars_select on storage.objects for select to anon, authenticated
using (bucket_id = 'avatars' and public.current_profile_id() is not null);

drop policy if exists avatars_insert on storage.objects;
create policy avatars_insert on storage.objects for insert to anon, authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = public.current_profile_id()::text
);

drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects for update to anon, authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = public.current_profile_id()::text
)
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = public.current_profile_id()::text
);

drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete to anon, authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = public.current_profile_id()::text
);
