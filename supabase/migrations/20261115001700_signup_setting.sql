-- =====================================================================
-- 1700  PUBLIC SIGN-UP SWITCH (internal HRMS vs SaaS product)
-- One code base serves two deployments:
--   * SaaS product: anyone may create an account and their own company (public_signup = true, the default,
--     so existing behaviour is unchanged after this migration).
--   * Internal HRMS for one organisation: public_signup = false. Only platform admins may create companies;
--     everyone else joins by invitation. Account sign-up itself stays open because invitation and
--     "activate your account" emails link to /signup?email=..., and create_company is the only way a
--     non-invited account could get a workspace.
-- Switch it (as the project owner, SQL editor / Management API):
--   update public.platform_settings set public_signup = false, updated_at = now();
-- No table is dropped, no data is deleted, no policy is loosened.
-- =====================================================================

create table if not exists public.platform_settings (
  id boolean primary key default true check (id),           -- single row
  public_signup boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (id) values (true) on conflict (id) do nothing;
alter table public.platform_settings enable row level security;
-- no policies: read through public_signup_enabled(), changed only by the project owner
revoke all on public.platform_settings from public, anon, authenticated;

-- the frontend reads this to show or hide "Create your company" (anonymous visitors included)
create or replace function public.public_signup_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public_signup from public.platform_settings where id), true)
$$;
revoke execute on function public.public_signup_enabled() from public;
grant execute on function public.public_signup_enabled() to anon, authenticated;

-- create_company: unchanged except for the public_signup guard after the authentication check
create or replace function public.create_company(p_name text, p_slug text, p_email text default null, p_country text default 'India')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_role uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not public.public_signup_enabled() and not public.is_super_admin() then
    raise exception 'New companies cannot be created here. Ask your HR administrator to invite you.' using errcode = '42501';
  end if;
  if char_length(coalesce(trim(p_name), '')) < 2 then raise exception 'Company name is required'; end if;
  if p_slug !~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$' then
    raise exception 'URL slug must be 3-50 characters: lowercase letters, numbers and hyphens';
  end if;
  if exists (select 1 from public.companies where slug = p_slug) then
    raise exception 'The URL slug "%" is already taken', p_slug using errcode = '23505';
  end if;
  -- simple abuse guard: max 5 companies created per user per day
  if (select count(*) from public.companies where created_by = auth.uid() and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Too many companies created today. Please try again tomorrow.';
  end if;

  insert into public.companies (name, slug, email, country, created_by, status, plan)
  values (trim(p_name), p_slug, nullif(trim(coalesce(p_email, '')), ''), coalesce(p_country, 'India'), auth.uid(), 'trial', 'trial')
  returning id into v_id;
  perform public.seed_company_defaults(v_id);
  select id into v_role from public.roles where company_id = v_id and is_admin limit 1;
  insert into public.company_members (company_id, user_id, role_id) values (v_id, auth.uid(), v_role);
  update public.profiles set last_company_id = v_id where id = auth.uid();
  return v_id;
end $$;
