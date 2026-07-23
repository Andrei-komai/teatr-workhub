create table if not exists public.notification_preferences (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  events_enabled boolean not null default true,
  classes_enabled boolean not null default true,
  messages_enabled boolean not null default true,
  reminder_minutes integer not null default 120 check (reminder_minutes between 5 and 1440),
  updated_at timestamptz not null default now()
);

insert into public.notification_preferences (profile_id)
select id from public.profiles
on conflict (profile_id) do nothing;

create or replace function public.create_default_notification_preferences()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notification_preferences (profile_id)
  values (new.id)
  on conflict (profile_id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_default_notification_preferences on public.profiles;
create trigger create_default_notification_preferences
after insert on public.profiles
for each row execute function public.create_default_notification_preferences();

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_profile_id_idx
  on public.push_subscriptions(profile_id);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  source_type text not null check (source_type in ('event', 'class', 'message')),
  source_id uuid not null,
  scheduled_for timestamptz not null,
  sent_at timestamptz not null default now(),
  unique (subscription_id, source_type, source_id, scheduled_for)
);

alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_deliveries enable row level security;

revoke all on public.notification_preferences, public.push_subscriptions, public.notification_deliveries from anon, authenticated;

create or replace function public.get_own_notification_settings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
  result jsonb;
begin
  if actor_id is null then
    raise exception 'personal_login_required';
  end if;

  insert into public.notification_preferences (profile_id)
  values (actor_id)
  on conflict (profile_id) do nothing;

  select jsonb_build_object(
    'events_enabled', p.events_enabled,
    'classes_enabled', p.classes_enabled,
    'messages_enabled', p.messages_enabled,
    'reminder_minutes', p.reminder_minutes,
    'device_count', (select count(*) from public.push_subscriptions s where s.profile_id = actor_id)
  )
  into result
  from public.notification_preferences p
  where p.profile_id = actor_id;

  return result;
end;
$$;

create or replace function public.set_own_notification_preferences(
  enable_events boolean,
  enable_classes boolean,
  enable_messages boolean
)
returns jsonb
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

  insert into public.notification_preferences (
    profile_id,
    events_enabled,
    classes_enabled,
    messages_enabled,
    updated_at
  )
  values (
    actor_id,
    coalesce(enable_events, true),
    coalesce(enable_classes, true),
    coalesce(enable_messages, true),
    now()
  )
  on conflict (profile_id) do update
  set events_enabled = excluded.events_enabled,
      classes_enabled = excluded.classes_enabled,
      messages_enabled = excluded.messages_enabled,
      updated_at = now();

  return public.get_own_notification_settings();
end;
$$;

create or replace function public.save_own_push_subscription(
  subscription_endpoint text,
  subscription_p256dh text,
  subscription_auth text,
  subscription_user_agent text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
  subscription_id uuid;
begin
  if actor_id is null then
    raise exception 'personal_login_required';
  end if;

  if nullif(trim(subscription_endpoint), '') is null
    or nullif(trim(subscription_p256dh), '') is null
    or nullif(trim(subscription_auth), '') is null then
    raise exception 'invalid_push_subscription';
  end if;

  insert into public.push_subscriptions (
    profile_id,
    endpoint,
    p256dh,
    auth,
    user_agent,
    updated_at
  )
  values (
    actor_id,
    subscription_endpoint,
    subscription_p256dh,
    subscription_auth,
    left(coalesce(subscription_user_agent, ''), 500),
    now()
  )
  on conflict (endpoint) do update
  set profile_id = actor_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = excluded.user_agent,
      updated_at = now()
  returning id into subscription_id;

  return subscription_id;
end;
$$;

create or replace function public.remove_own_push_subscription(subscription_endpoint text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
  removed_count integer;
begin
  if actor_id is null then
    raise exception 'personal_login_required';
  end if;

  delete from public.push_subscriptions
  where profile_id = actor_id
    and endpoint = subscription_endpoint;

  get diagnostics removed_count = row_count;
  return removed_count > 0;
end;
$$;

revoke all on function public.get_own_notification_settings() from public;
revoke all on function public.set_own_notification_preferences(boolean, boolean, boolean) from public;
revoke all on function public.save_own_push_subscription(text, text, text, text) from public;
revoke all on function public.remove_own_push_subscription(text) from public;

grant execute on function public.get_own_notification_settings() to anon, authenticated;
grant execute on function public.set_own_notification_preferences(boolean, boolean, boolean) to anon, authenticated;
grant execute on function public.save_own_push_subscription(text, text, text, text) to anon, authenticated;
grant execute on function public.remove_own_push_subscription(text) to anon, authenticated;
