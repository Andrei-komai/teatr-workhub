do $$
declare
  old_wardrobe_id text;
begin
  select id into old_wardrobe_id
  from public.sections
  where id <> 'wardrobe'
    and replace(lower(title), 'ё', 'е') ~ 'костюмер'
  order by sort_order
  limit 1;

  if not exists (select 1 from public.sections where id = 'wardrobe') then
    if old_wardrobe_id is not null then
      update public.profiles
      set sections = array_replace(sections, old_wardrobe_id, 'wardrobe')
      where old_wardrobe_id = any(sections);

      update public.sections
      set id = 'wardrobe',
          title = 'Костюмерная',
          description = 'Костюмы, реквизит и всё необходимое для спектаклей',
          access_roles = array['developer', 'leader', 'teacher', 'admin', 'participant'],
          enabled = true
      where id = old_wardrobe_id;
    else
      insert into public.sections (id, title, description, access_roles, enabled, sort_order)
      select
        'wardrobe',
        'Костюмерная',
        'Костюмы, реквизит и всё необходимое для спектаклей',
        array['developer', 'leader', 'teacher', 'admin', 'participant'],
        true,
        coalesce(max(sort_order), 0) + 1
      from public.sections;
    end if;
  else
    update public.sections
    set title = 'Костюмерная',
        description = 'Костюмы, реквизит и всё необходимое для спектаклей',
        access_roles = array['developer', 'leader', 'teacher', 'admin', 'participant'],
        enabled = true
    where id = 'wardrobe';
  end if;
end $$;

create table if not exists public.wardrobe_items (
  id uuid primary key default gen_random_uuid(),
  performance text not null check (length(trim(performance)) between 2 and 120),
  item_quantity text not null check (length(trim(item_quantity)) between 2 and 500),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wardrobe_items_performance_updated_idx
  on public.wardrobe_items(performance, updated_at desc);

create or replace function public.set_wardrobe_item_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := public.current_profile_id();
begin
  if actor_id is null then
    raise exception 'Личный профиль не найден';
  end if;

  new.performance := trim(new.performance);
  new.item_quantity := trim(new.item_quantity);
  new.updated_by := actor_id;
  select name into new.updated_by_name from public.profiles where id = actor_id;
  new.updated_by_name := coalesce(new.updated_by_name, 'Участник');
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists wardrobe_items_set_audit on public.wardrobe_items;
create trigger wardrobe_items_set_audit
before insert or update on public.wardrobe_items
for each row execute function public.set_wardrobe_item_audit();

alter table public.wardrobe_items enable row level security;

drop policy if exists wardrobe_items_select on public.wardrobe_items;
create policy wardrobe_items_select on public.wardrobe_items for select to anon, authenticated
using (public.has_section_access('wardrobe'));

drop policy if exists wardrobe_items_insert on public.wardrobe_items;
create policy wardrobe_items_insert on public.wardrobe_items for insert to anon, authenticated
with check (
  public.has_section_access('wardrobe')
  and public.current_user_role() in ('developer', 'leader', 'teacher', 'admin')
  and updated_by = public.current_profile_id()
);

drop policy if exists wardrobe_items_update on public.wardrobe_items;
create policy wardrobe_items_update on public.wardrobe_items for update to anon, authenticated
using (
  public.has_section_access('wardrobe')
  and public.current_user_role() in ('developer', 'leader', 'teacher', 'admin')
)
with check (
  public.has_section_access('wardrobe')
  and public.current_user_role() in ('developer', 'leader', 'teacher', 'admin')
  and updated_by = public.current_profile_id()
);

drop policy if exists wardrobe_items_delete on public.wardrobe_items;
create policy wardrobe_items_delete on public.wardrobe_items for delete to anon, authenticated
using (
  public.has_section_access('wardrobe')
  and public.current_user_role() in ('developer', 'leader', 'teacher', 'admin')
);

revoke all on public.wardrobe_items from anon, authenticated;
grant select, insert, update, delete on public.wardrobe_items to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.wardrobe_items;
exception when duplicate_object then
  null;
end $$;
