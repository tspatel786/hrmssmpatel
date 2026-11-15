-- =====================================================================
-- 0100  CORE: tenancy, identity, roles & permissions
-- =====================================================================

-- ---------- utility ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.try_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

-- ---------- platform ----------
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$'),
  legal_name text,
  email text,
  phone text,
  website text,
  address text,
  city text,
  state text,
  country text default 'India',
  postal_code text,
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR',
  date_format text not null default 'dd MMM yyyy',
  logo_url text,
  primary_color text not null default '#2549eb' check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  -- careers site
  careers_enabled boolean not null default true,
  careers_tagline text default 'Build your career with us',
  careers_about text,
  -- HR settings
  employee_code_prefix text not null default 'EMP',
  employee_code_seq integer not null default 0,
  offer_approval_required boolean not null default true,
  offer_validity_days integer not null default 7 check (offer_validity_days between 1 and 90),
  work_start time not null default '09:30',
  work_end time not null default '18:30',
  working_days smallint[] not null default '{1,2,3,4,5}', -- ISO dow 1=Mon..7=Sun
  -- payroll settings
  pf_enabled boolean not null default true,
  pf_percent numeric(5,2) not null default 12 check (pf_percent between 0 and 50),
  professional_tax numeric(10,2) not null default 200 check (professional_tax >= 0),
  tds_percent numeric(5,2) not null default 0 check (tds_percent between 0 and 50),
  -- email
  email_from_name text,
  email_reply_to text,
  -- SaaS
  status text not null default 'active' check (status in ('active','trial','suspended')),
  plan text not null default 'trial' check (plan in ('trial','starter','growth','enterprise')),
  max_employees integer not null default 50 check (max_employees > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_companies_updated before update on public.companies
  for each row execute function public.set_updated_at();

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  phone text,
  last_company_id uuid references public.companies(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_email_lower_idx on public.profiles (lower(email));
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

-- create profile automatically for every new auth user
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- permissions catalog ----------
create table public.permissions (
  key text primary key,
  module text not null,
  label text not null,
  sort_order integer not null default 0
);

insert into public.permissions (key, module, label, sort_order) values
  ('dashboard.view','Dashboard','View dashboard & analytics',10),
  ('settings.manage','Settings','Manage company settings',20),
  ('users.manage','Users & Roles','Manage users, invitations and roles',30),
  ('departments.view','Organization','View departments & designations',40),
  ('departments.manage','Organization','Manage departments & designations',41),
  ('employees.view','Employees','View employees',50),
  ('employees.manage','Employees','Create / edit employees',51),
  ('requisitions.view','Recruitment','View job requisitions',60),
  ('requisitions.manage','Recruitment','Create / edit job requisitions',61),
  ('requisitions.approve','Recruitment','Approve job requisitions',62),
  ('jobs.view','Recruitment','View job openings',70),
  ('jobs.manage','Recruitment','Create / publish job openings',71),
  ('candidates.view','Recruitment','View candidates & applications',80),
  ('candidates.manage','Recruitment','Manage candidates & pipeline',81),
  ('interviews.view','Recruitment','View all interviews',90),
  ('interviews.manage','Recruitment','Schedule & manage interviews',91),
  ('offers.view','Offers','View offers',100),
  ('offers.manage','Offers','Create / send offers',101),
  ('offers.approve','Offers','Approve offers',102),
  ('onboarding.view','Onboarding','View onboarding',110),
  ('onboarding.manage','Onboarding','Manage onboarding',111),
  ('emails.manage','Email','Manage email templates & logs',120),
  ('attendance.view','Attendance','View team attendance',130),
  ('attendance.manage','Attendance','Edit attendance & holidays',131),
  ('leave.view','Leave','View all leave',140),
  ('leave.manage','Leave','Manage leave types & balances',141),
  ('leave.approve','Leave','Approve leave requests',142),
  ('payroll.view','Payroll','View payroll',150),
  ('payroll.manage','Payroll','Run payroll',151),
  ('reports.view','Reports','View & export reports',160),
  ('audit.view','Audit','View audit logs',170);

-- ---------- roles ----------
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 60),
  description text,
  is_system boolean not null default false,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);
create index roles_company_idx on public.roles (company_id);
create trigger trg_roles_updated before update on public.roles
  for each row execute function public.set_updated_at();

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission text not null references public.permissions(key) on delete cascade,
  primary key (role_id, permission)
);

create table public.company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  employee_id uuid, -- FK added after employees table exists
  status text not null default 'active' check (status in ('active','inactive')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id)
);
create index company_members_user_idx on public.company_members (user_id, company_id) where status = 'active';
create trigger trg_members_updated before update on public.company_members
  for each row execute function public.set_updated_at();

create table public.company_invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role_id uuid not null references public.roles(id) on delete cascade,
  employee_id uuid,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  invited_by uuid references auth.users(id) on delete set null default auth.uid(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index company_invitations_pending_idx on public.company_invitations (company_id, lower(email)) where status = 'pending';

-- ---------- security helper functions ----------
-- SECURITY DEFINER so they can read membership tables without recursive RLS.
create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

create or replace function public.is_member(p_company uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_members m
    join public.companies c on c.id = m.company_id
    where m.company_id = p_company and m.user_id = auth.uid()
      and m.status = 'active' and c.status <> 'suspended'
  ) or public.is_super_admin()
$$;

create or replace function public.has_permission(p_company uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super_admin() or exists (
    select 1
    from public.company_members m
    join public.companies c on c.id = m.company_id
    join public.roles r on r.id = m.role_id
    left join public.role_permissions rp on rp.role_id = r.id and rp.permission = p_permission
    where m.company_id = p_company and m.user_id = auth.uid()
      and m.status = 'active' and c.status <> 'suspended'
      and (r.is_admin or rp.permission is not null)
  )
$$;

create or replace function public.my_employee_id(p_company uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select employee_id from public.company_members
  where company_id = p_company and user_id = auth.uid() and status = 'active'
$$;

create or replace function public.shares_company(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_user = auth.uid() or public.is_super_admin() or exists (
    select 1 from public.company_members a
    join public.company_members b on a.company_id = b.company_id
    where a.user_id = auth.uid() and a.status = 'active' and b.user_id = p_user
  )
$$;

-- returns the permission keys of the current user in a company (for UI gating)
create or replace function public.my_permissions(p_company uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select case
    when public.is_super_admin() then (select array_agg(key order by sort_order) from public.permissions)
    else coalesce((
      select case when r.is_admin then (select array_agg(key order by sort_order) from public.permissions)
                  else (select array_agg(rp.permission) from public.role_permissions rp where rp.role_id = r.id) end
      from public.company_members m
      join public.companies c on c.id = m.company_id
      join public.roles r on r.id = m.role_id
      where m.company_id = p_company and m.user_id = auth.uid() and m.status = 'active' and c.status <> 'suspended'
    ), '{}')
  end
$$;
