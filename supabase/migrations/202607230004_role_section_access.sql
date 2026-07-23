create or replace function public.has_section_access(section_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.sections s on s.id = section_name
    where p.id = public.current_profile_id()
      and (
        p.role in ('developer', 'leader')
        or section_name = any(p.sections)
        or p.role = any(coalesce(s.access_roles, '{}'))
      )
  );
$$;

grant execute on function public.has_section_access(text) to anon, authenticated;
