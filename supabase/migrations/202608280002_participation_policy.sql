do $$
declare
  old_policy_id text;
begin
  select id into old_policy_id
  from public.sections
  where id <> 'participation-policy'
    and (
      replace(lower(title), 'ё', 'е') ~ 'положен.*участ'
      or replace(lower(title), 'ё', 'е') ~ 'пользовател.*соглаш'
    )
  order by sort_order
  limit 1;

  if not exists (select 1 from public.sections where id = 'participation-policy') then
    if old_policy_id is not null then
      update public.profiles
      set sections = array_replace(sections, old_policy_id, 'participation-policy')
      where old_policy_id = any(sections);

      update public.sections
      set id = 'participation-policy',
          title = 'Положение об участии',
          description = 'Правила участия и обязанности в театре Т.А.М.',
          access_roles = array['developer', 'leader', 'teacher', 'admin', 'participant'],
          enabled = true
      where id = old_policy_id;
    else
      insert into public.sections (id, title, description, access_roles, enabled, sort_order)
      select
        'participation-policy',
        'Положение об участии',
        'Правила участия и обязанности в театре Т.А.М.',
        array['developer', 'leader', 'teacher', 'admin', 'participant'],
        true,
        coalesce(max(sort_order), 0) + 1
      from public.sections;
    end if;
  else
    update public.sections
    set title = 'Положение об участии',
        description = 'Правила участия и обязанности в театре Т.А.М.',
        access_roles = array['developer', 'leader', 'teacher', 'admin', 'participant'],
        enabled = true
    where id = 'participation-policy';
  end if;
end $$;

create table if not exists public.participation_policy_signatures (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  policy_version text not null default '1.1' check (policy_version = '1.1'),
  signer_name text not null,
  signed_at timestamptz not null default now(),
  unique (profile_id, policy_version)
);

create index if not exists participation_policy_signatures_signed_at_idx
  on public.participation_policy_signatures(signed_at desc);

create or replace function public.set_participation_policy_signature()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
begin
  if actor_id is null or not public.has_section_access('participation-policy') then
    raise exception 'Личный профиль не найден';
  end if;

  new.profile_id := actor_id;
  new.policy_version := '1.1';
  select name into new.signer_name from public.profiles where id = actor_id;
  new.signer_name := coalesce(nullif(trim(new.signer_name), ''), 'Участник');
  new.signed_at := now();
  return new;
end;
$$;

drop trigger if exists participation_policy_signatures_set_audit on public.participation_policy_signatures;
create trigger participation_policy_signatures_set_audit
before insert on public.participation_policy_signatures
for each row execute function public.set_participation_policy_signature();

alter table public.participation_policy_signatures enable row level security;

drop policy if exists participation_policy_signatures_select on public.participation_policy_signatures;
create policy participation_policy_signatures_select on public.participation_policy_signatures for select to anon, authenticated
using (
  profile_id = public.current_profile_id()
  or public.current_user_role() in ('developer', 'leader', 'teacher', 'admin')
);

drop policy if exists participation_policy_signatures_insert on public.participation_policy_signatures;
create policy participation_policy_signatures_insert on public.participation_policy_signatures for insert to anon, authenticated
with check (
  public.has_section_access('participation-policy')
  and profile_id = public.current_profile_id()
  and policy_version = '1.1'
);

revoke all on public.participation_policy_signatures from anon, authenticated;
grant select, insert on public.participation_policy_signatures to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.participation_policy_signatures;
exception when duplicate_object then
  null;
end $$;
