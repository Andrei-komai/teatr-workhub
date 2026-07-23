create table if not exists public.hub_access_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days')
);

create index if not exists hub_access_sessions_expiry_idx
  on public.hub_access_sessions(expires_at);

revoke all on public.hub_access_sessions from anon, authenticated;

create or replace function public.can_manage_content()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() in ('developer', 'leader', 'teacher', 'admin');
$$;

create or replace function public.login_with_hub_password(attempt text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  raw_token text;
begin
  delete from public.hub_access_sessions where expires_at <= now();

  if not exists (
    select 1
    from public.hub_settings
    where key = 'password_hash'
      and value = crypt(attempt, value)
  ) then
    return jsonb_build_object('status', 'wrong_password');
  end if;

  raw_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.hub_access_sessions(token_hash)
  values (encode(digest(raw_token, 'sha256'), 'hex'));

  return jsonb_build_object('status', 'ok', 'token', raw_token);
end;
$$;

create or replace function public.validate_hub_session(session_token text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.hub_access_sessions
    where session_token is not null
      and token_hash = encode(digest(session_token, 'sha256'), 'hex')
      and expires_at > now()
  );
$$;

create or replace function public.change_hub_password(new_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  raw_token text;
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

  delete from public.hub_access_sessions;

  raw_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.hub_access_sessions(token_hash)
  values (encode(digest(raw_token, 'sha256'), 'hex'));

  return jsonb_build_object('status', 'ok', 'token', raw_token);
end;
$$;

create or replace function public.add_material_reaction(material_id uuid, reaction_emoji text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_section_access('collection') then
    raise exception 'insufficient_privilege';
  end if;
  if reaction_emoji not in ('❤️', '👍', '🔥', '👏', '😁', '👎') then
    raise exception 'invalid_reaction';
  end if;

  update public.materials
  set reactions = jsonb_set(
    coalesce(reactions, '{}'::jsonb),
    array[reaction_emoji],
    to_jsonb(coalesce((reactions ->> reaction_emoji)::integer, 0) + 1),
    true
  )
  where id = material_id and deleted_at is null;

  if not found then
    raise exception 'material_not_found';
  end if;
end;
$$;

create or replace function public.add_material_comment(material_id uuid, comment_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
  clean_text text := trim(comment_text);
begin
  if not public.has_section_access('collection') then
    raise exception 'insufficient_privilege';
  end if;
  if clean_text is null or clean_text = '' then
    raise exception 'empty_comment';
  end if;

  select name into actor_name
  from public.profiles
  where id = public.current_profile_id();

  update public.materials
  set comments = coalesce(comments, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'author', coalesce(actor_name, 'Участник'),
      'text', clean_text,
      'createdAt', (extract(epoch from clock_timestamp()) * 1000)::bigint
    )
  )
  where id = material_id and deleted_at is null;

  if not found then
    raise exception 'material_not_found';
  end if;
end;
$$;

create or replace function public.delete_material_forever(material_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_content() then
    raise exception 'insufficient_privilege';
  end if;

  delete from public.materials
  where id = material_id and deleted_at is not null;

  if not found then
    raise exception 'material_not_in_trash';
  end if;
end;
$$;

revoke execute on function public.set_hub_password(text) from public, anon, authenticated;
revoke execute on function public.login_with_hub_password(text) from public;
revoke execute on function public.validate_hub_session(text) from public;
revoke execute on function public.change_hub_password(text) from public;
revoke execute on function public.add_material_reaction(uuid, text) from public;
revoke execute on function public.add_material_comment(uuid, text) from public;
revoke execute on function public.can_manage_content() from public;

grant execute on function public.login_with_hub_password(text) to anon, authenticated;
grant execute on function public.validate_hub_session(text) to anon, authenticated;
grant execute on function public.change_hub_password(text) to anon, authenticated;
grant execute on function public.add_material_reaction(uuid, text) to anon, authenticated;
grant execute on function public.add_material_comment(uuid, text) to anon, authenticated;
grant execute on function public.can_manage_content() to anon, authenticated;
grant execute on function public.delete_material_forever(uuid) to anon, authenticated;
