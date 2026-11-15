-- =====================================================================
-- 0200  PEOPLE: departments, designations, employees, attendance, leave, payroll
-- =====================================================================

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  code text,
  description text,
  head_employee_id uuid,
  parent_id uuid references public.departments(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);
create index departments_company_idx on public.departments (company_id);
create trigger trg_departments_updated before update on public.departments
  for each row execute function public.set_updated_at();

create table public.designations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 80),
  level text,
  department_id uuid references public.departments(id) on delete set null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, title)
);
create index designations_company_idx on public.designations (company_id);
create trigger trg_designations_updated before update on public.designations
  for each row execute function public.set_updated_at();

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_code text not null,
  user_id uuid references auth.users(id) on delete set null,
  first_name text not null check (char_length(first_name) between 1 and 60),
  last_name text not null default '',
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text,
  date_of_birth date,
  gender text check (gender in ('male','female','other','undisclosed')),
  marital_status text check (marital_status in ('single','married','other')),
  address text,
  city text,
  state text,
  country text,
  postal_code text,
  emergency_contact_name text,
  emergency_contact_phone text,
  department_id uuid references public.departments(id) on delete set null,
  designation_id uuid references public.designations(id) on delete set null,
  manager_id uuid references public.employees(id) on delete set null,
  employment_type text not null default 'full_time' check (employment_type in ('full_time','part_time','contract','intern')),
  work_location text,
  joining_date date not null default current_date,
  probation_end_date date,
  exit_date date,
  status text not null default 'active' check (status in ('active','probation','notice','inactive','terminated')),
  -- compensation (monthly)
  ctc_annual numeric(14,2) not null default 0 check (ctc_annual >= 0),
  basic_monthly numeric(12,2) not null default 0 check (basic_monthly >= 0),
  hra_monthly numeric(12,2) not null default 0 check (hra_monthly >= 0),
  allowances_monthly numeric(12,2) not null default 0 check (allowances_monthly >= 0),
  fixed_deductions_monthly numeric(12,2) not null default 0 check (fixed_deductions_monthly >= 0),
  -- statutory / bank
  pan_number text,
  bank_name text,
  bank_account_number text,
  bank_ifsc text,
  -- provenance
  candidate_id uuid,
  application_id uuid,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, employee_code),
  check (exit_date is null or exit_date >= joining_date)
);
create unique index employees_email_idx on public.employees (company_id, lower(email));
create index employees_company_status_idx on public.employees (company_id, status);
create index employees_department_idx on public.employees (department_id);
create index employees_manager_idx on public.employees (manager_id);
create index employees_user_idx on public.employees (user_id);
create trigger trg_employees_updated before update on public.employees
  for each row execute function public.set_updated_at();

alter table public.departments add constraint departments_head_fk
  foreign key (head_employee_id) references public.employees(id) on delete set null;
alter table public.company_members add constraint company_members_employee_fk
  foreign key (employee_id) references public.employees(id) on delete set null;
alter table public.company_invitations add constraint company_invitations_employee_fk
  foreign key (employee_id) references public.employees(id) on delete set null;

-- auto-generate employee codes: PREFIX-0001
create or replace function public.assign_employee_code() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_prefix text; v_seq integer;
begin
  if new.employee_code is null or new.employee_code = '' then
    update public.companies set employee_code_seq = employee_code_seq + 1
      where id = new.company_id returning employee_code_prefix, employee_code_seq into v_prefix, v_seq;
    new.employee_code := v_prefix || '-' || lpad(v_seq::text, 4, '0');
  end if;
  new.email := lower(trim(new.email));
  return new;
end $$;
create trigger trg_employees_code before insert on public.employees
  for each row execute function public.assign_employee_code();

-- enforce plan employee limit
create or replace function public.enforce_employee_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_max integer; v_count integer;
begin
  select max_employees into v_max from public.companies where id = new.company_id;
  select count(*) into v_count from public.employees
   where company_id = new.company_id and status not in ('inactive','terminated');
  if v_count >= v_max then
    raise exception 'Employee limit reached for your plan (% employees). Contact the platform administrator to upgrade.', v_max
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_employees_limit before insert on public.employees
  for each row execute function public.enforce_employee_limit();

-- ---------- attendance ----------
create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  holiday_date date not null,
  is_optional boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, holiday_date)
);

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  attendance_date date not null,
  check_in timestamptz,
  check_out timestamptz,
  status text not null default 'present' check (status in ('present','absent','half_day','on_leave','holiday','weekend')),
  work_minutes integer generated always as (
    case when check_in is not null and check_out is not null
      then greatest(0, (extract(epoch from (check_out - check_in)) / 60)::integer) end
  ) stored,
  source text not null default 'manual' check (source in ('self','manual','system')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, attendance_date),
  check (check_out is null or check_in is null or check_out >= check_in)
);
create index attendance_company_date_idx on public.attendance_records (company_id, attendance_date);
create trigger trg_attendance_updated before update on public.attendance_records
  for each row execute function public.set_updated_at();

-- ---------- leave ----------
create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 60),
  code text not null check (char_length(code) between 1 and 10),
  annual_quota numeric(5,1) not null default 0 check (annual_quota between 0 and 365),
  is_paid boolean not null default true,
  carry_forward boolean not null default false,
  color text not null default '#2549eb',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table public.leave_balances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete cascade,
  year integer not null,
  allocated numeric(5,1) not null default 0 check (allocated >= 0),
  used numeric(5,1) not null default 0 check (used >= 0),
  unique (employee_id, leave_type_id, year)
);
create index leave_balances_company_idx on public.leave_balances (company_id, year);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  half_day boolean not null default false,
  days numeric(5,1) not null check (days > 0),
  reason text not null check (char_length(reason) between 3 and 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approver_id uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index leave_requests_company_status_idx on public.leave_requests (company_id, status);
create index leave_requests_employee_idx on public.leave_requests (employee_id, start_date);
create trigger trg_leave_requests_updated before update on public.leave_requests
  for each row execute function public.set_updated_at();

-- ---------- payroll ----------
create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  period_year integer not null check (period_year between 2000 and 2100),
  period_month integer not null check (period_month between 1 and 12),
  status text not null default 'draft' check (status in ('draft','processed','paid')),
  working_days integer not null default 0,
  employee_count integer not null default 0,
  total_gross numeric(16,2) not null default 0,
  total_deductions numeric(16,2) not null default 0,
  total_net numeric(16,2) not null default 0,
  processed_at timestamptz,
  paid_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, period_year, period_month)
);
create trigger trg_payroll_runs_updated before update on public.payroll_runs
  for each row execute function public.set_updated_at();

create table public.payslips (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  working_days integer not null,
  paid_days numeric(5,1) not null,
  lop_days numeric(5,1) not null default 0,
  basic numeric(12,2) not null default 0,
  hra numeric(12,2) not null default 0,
  allowances numeric(12,2) not null default 0,
  gross numeric(12,2) not null default 0,
  pf numeric(12,2) not null default 0,
  professional_tax numeric(12,2) not null default 0,
  tds numeric(12,2) not null default 0,
  other_deductions numeric(12,2) not null default 0,
  total_deductions numeric(12,2) not null default 0,
  net_pay numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (payroll_run_id, employee_id)
);
create index payslips_employee_idx on public.payslips (employee_id);
create index payslips_company_idx on public.payslips (company_id);
