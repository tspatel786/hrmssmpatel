-- =====================================================================
-- 1300  ATTENDANCE & LEAVE GAPS
--   * late-arrival / early-departure flags (company office hours + grace period)
--   * employee attendance correction requests with manager/HR approval
--   * team leave calendar (privacy-preserving: no reasons, scoped visibility)
-- =====================================================================

-- ---------- late / early flags ----------
alter table public.companies
  add column late_grace_minutes integer not null default 10 check (late_grace_minutes between 0 and 240);

alter table public.attendance_records
  add column late_minutes integer not null default 0 check (late_minutes >= 0),
  add column early_exit_minutes integer not null default 0 check (early_exit_minutes >= 0),
  add column is_late boolean not null default false,
  add column is_early_exit boolean not null default false;

-- Flags are derived on every write path (clock in/out, HR edits, approved corrections, leave sync).
create or replace function public.attendance_set_flags() returns trigger
language plpgsql security definer set search_path = public as $$
declare c public.companies; v_start timestamptz; v_end timestamptz; v_late int := 0; v_early int := 0;
begin
  select * into c from public.companies where id = new.company_id;
  if new.status in ('present','half_day') and c.id is not null then
    v_start := (new.attendance_date + c.work_start) at time zone c.timezone;
    v_end := (new.attendance_date + c.work_end) at time zone c.timezone;
    if new.check_in is not null then v_late := greatest(0, floor(extract(epoch from (new.check_in - v_start)) / 60))::int; end if;
    if new.check_out is not null then v_early := greatest(0, floor(extract(epoch from (v_end - new.check_out)) / 60))::int; end if;
  end if;
  new.is_late := v_late > coalesce(c.late_grace_minutes, 0);
  new.is_early_exit := v_early > coalesce(c.late_grace_minutes, 0);
  new.late_minutes := case when new.is_late then v_late else 0 end;
  new.early_exit_minutes := case when new.is_early_exit then v_early else 0 end;
  return new;
end $$;
create trigger trg_attendance_flags before insert or update of check_in, check_out, status, attendance_date on public.attendance_records
  for each row execute function public.attendance_set_flags();

-- backfill existing rows without touching updated_at
alter table public.attendance_records disable trigger trg_attendance_updated;
update public.attendance_records set status = status;
alter table public.attendance_records enable trigger trg_attendance_updated;

-- view exposes the new columns (a.* is expanded at creation time, so recreate)
drop view if exists public.v_attendance;
create view public.v_attendance with (security_invoker = true) as
select a.*, e.employee_code, trim(e.first_name || ' ' || e.last_name) as employee_name, e.department_id, d.name as department_name
from public.attendance_records a
join public.employees e on e.id = a.employee_id
left join public.departments d on d.id = e.department_id;
revoke all on public.v_attendance from anon;

drop function if exists public.report_attendance(uuid, date, date);
create function public.report_attendance(p_company uuid, p_from date, p_to date)
returns table (employee_code text, employee_name text, department text, present bigint, half_day bigint, absent bigint,
  on_leave bigint, late_arrivals bigint, early_departures bigint, total_hours numeric, avg_hours numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_permission(p_company, 'reports.view');
  if p_to < p_from or p_to - p_from > 366 then raise exception 'Choose a date range of up to one year'; end if;
  return query
  select e.employee_code, trim(e.first_name || ' ' || e.last_name), d.name,
    count(a.id) filter (where a.status = 'present'), count(a.id) filter (where a.status = 'half_day'),
    count(a.id) filter (where a.status = 'absent'), count(a.id) filter (where a.status = 'on_leave'),
    count(a.id) filter (where a.is_late), count(a.id) filter (where a.is_early_exit),
    round(coalesce(sum(a.work_minutes), 0) / 60.0, 1),
    round(coalesce(avg(a.work_minutes) filter (where a.work_minutes > 0), 0) / 60.0, 1)
  from public.employees e
  left join public.departments d on d.id = e.department_id
  left join public.attendance_records a on a.employee_id = e.id and a.attendance_date between p_from and p_to
  where e.company_id = p_company and e.status not in ('inactive','terminated')
  group by e.id, d.name order by e.employee_code;
end $$;

-- ---------- attendance correction requests ----------
create table public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  attendance_date date not null,
  requested_status text not null check (requested_status in ('present','half_day','absent')),
  requested_check_in timestamptz,
  requested_check_out timestamptz,
  reason text not null check (char_length(reason) between 5 and 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  -- snapshot of the record at request time (for the reviewer)
  original_check_in timestamptz,
  original_check_out timestamptz,
  original_status text,
  reviewer_id uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 1000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requested_check_out is null or requested_check_in is null or requested_check_out > requested_check_in)
);
create unique index attendance_corrections_one_pending on public.attendance_corrections (employee_id, attendance_date) where status = 'pending';
create index attendance_corrections_company_idx on public.attendance_corrections (company_id, status, created_at desc);
create trigger trg_attendance_corrections_updated before update on public.attendance_corrections
  for each row execute function public.set_updated_at();
create trigger trg_same_company before insert or update on public.attendance_corrections for each row
  execute function public.guard_same_company('employee_id:employees');
create trigger trg_audit_attendance_corrections after insert or update or delete on public.attendance_corrections
  for each row execute function public.audit_trigger();

create or replace function public.can_review_correction(p_correction uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.attendance_corrections r join public.employees e on e.id = r.employee_id
    where r.id = p_correction
      and r.employee_id is distinct from public.my_employee_id(r.company_id)   -- never your own
      and (public.has_permission(r.company_id, 'attendance.manage') or e.manager_id = public.my_employee_id(r.company_id)))
$$;

create or replace function public.request_attendance_correction(p_company uuid, p_date date, p_status text,
  p_check_in timestamptz, p_check_out timestamptz, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); e public.employees; a public.attendance_records; v_id uuid; v_today date;
begin
  if v_emp is null then raise exception 'Your account is not linked to an employee profile'; end if;
  select * into e from public.employees where id = v_emp;
  v_today := (now() at time zone public.company_tz(p_company))::date;
  if p_date is null or p_date > v_today then raise exception 'Corrections can only be requested for past or current dates'; end if;
  if p_date < v_today - 60 then raise exception 'Corrections must be requested within 60 days'; end if;
  if p_status not in ('present','half_day','absent') then raise exception 'Invalid status'; end if;
  if p_status in ('present','half_day') and p_check_in is null then raise exception 'Check-in time is required'; end if;
  if p_check_in is not null and p_check_out is not null and p_check_out <= p_check_in then raise exception 'Check-out must be after check-in'; end if;
  if (p_check_in is not null and (p_check_in at time zone public.company_tz(p_company))::date <> p_date) then
    raise exception 'Check-in must be on the selected date';
  end if;
  if char_length(coalesce(trim(p_reason), '')) < 5 then raise exception 'Please explain the correction (at least 5 characters)'; end if;
  if exists (select 1 from public.attendance_corrections where employee_id = v_emp and attendance_date = p_date and status = 'pending') then
    raise exception 'You already have a pending correction for this date';
  end if;
  if exists (select 1 from public.payroll_runs pr where pr.company_id = p_company and pr.status in ('processed','paid')
             and pr.period_year = extract(year from p_date) and pr.period_month = extract(month from p_date)) then
    raise exception 'Payroll for this month is already processed; contact HR';
  end if;
  select * into a from public.attendance_records where employee_id = v_emp and attendance_date = p_date;
  insert into public.attendance_corrections (company_id, employee_id, attendance_date, requested_status, requested_check_in,
    requested_check_out, reason, original_check_in, original_check_out, original_status)
  values (p_company, v_emp, p_date, p_status, p_check_in, p_check_out, trim(p_reason), a.check_in, a.check_out, a.status)
  returning id into v_id;
  perform public.notify_user(p_company, (select m.user_id from public.employees m where m.id = e.manager_id), 'attendance',
    'Attendance correction request', trim(e.first_name || ' ' || e.last_name) || ' · ' || public.fmt_date(p_date), '/app/attendance?tab=corrections');
  perform public.notify_permission(p_company, 'attendance.manage', 'attendance', 'Attendance correction request',
    trim(e.first_name || ' ' || e.last_name) || ' · ' || public.fmt_date(p_date), '/app/attendance?tab=corrections');
  return v_id;
end $$;

create or replace function public.decide_attendance_correction(p_correction uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.attendance_corrections; e public.employees;
begin
  select * into r from public.attendance_corrections where id = p_correction for update;
  if r.id is null then raise exception 'Correction request not found'; end if;
  if not public.can_review_correction(r.id) then raise exception 'You are not allowed to review this request' using errcode = '42501'; end if;
  if r.status <> 'pending' then raise exception 'This request has already been %', r.status; end if;
  if not p_approve and char_length(coalesce(trim(p_note), '')) < 3 then raise exception 'Please give a reason for rejecting'; end if;
  select * into e from public.employees where id = r.employee_id;
  if p_approve then
    insert into public.attendance_records (company_id, employee_id, attendance_date, check_in, check_out, status, source, notes)
    values (r.company_id, r.employee_id, r.attendance_date, r.requested_check_in, r.requested_check_out, r.requested_status, 'manual',
            left('Correction: ' || r.reason, 500))
    on conflict (employee_id, attendance_date) do update set check_in = excluded.check_in, check_out = excluded.check_out,
      status = excluded.status, source = 'manual', notes = excluded.notes;
  end if;
  update public.attendance_corrections set status = case when p_approve then 'approved' else 'rejected' end,
    reviewer_id = auth.uid(), reviewed_at = now(), review_note = nullif(trim(coalesce(p_note, '')), '') where id = r.id;
  perform public.notify_user(r.company_id, e.user_id, 'attendance',
    'Attendance correction ' || case when p_approve then 'approved' else 'rejected' end,
    public.fmt_date(r.attendance_date) || coalesce(' · ' || nullif(trim(coalesce(p_note, '')), ''), ''), '/app/attendance?tab=corrections');
end $$;

create or replace function public.cancel_attendance_correction(p_correction uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.attendance_corrections;
begin
  select * into r from public.attendance_corrections where id = p_correction for update;
  if r.id is null or r.employee_id is distinct from public.my_employee_id(r.company_id) then raise exception 'Correction request not found'; end if;
  if r.status <> 'pending' then raise exception 'Only pending requests can be cancelled'; end if;
  update public.attendance_corrections set status = 'cancelled' where id = r.id;
end $$;

alter table public.attendance_corrections enable row level security;
create policy "read attendance corrections" on public.attendance_corrections for select to authenticated using (
  public.has_permission(company_id, 'attendance.view') or employee_id = public.my_employee_id(company_id) or public.manages_employee(employee_id));
revoke insert, update, delete on public.attendance_corrections from anon, authenticated;
revoke all on public.attendance_corrections from anon;

create view public.v_attendance_corrections with (security_invoker = true) as
select r.*, e.employee_code, trim(e.first_name || ' ' || e.last_name) as employee_name, e.manager_id, e.department_id,
  d.name as department_name, coalesce(p.full_name, p.email) as reviewer_name
from public.attendance_corrections r
join public.employees e on e.id = r.employee_id
left join public.departments d on d.id = e.department_id
left join public.profiles p on p.id = r.reviewer_id;
revoke all on public.v_attendance_corrections from anon;

-- ---------- team leave calendar ----------
-- HR / approvers see the whole company (optionally one department); everyone else sees approved leave of their own
-- department and direct reports, plus their own requests. Reasons are never returned.
create or replace function public.team_leave_calendar(p_company uuid, p_from date, p_to date, p_department uuid default null)
returns table (request_id uuid, employee_id uuid, employee_name text, employee_code text, department_name text,
  leave_type_name text, leave_type_color text, start_date date, end_date date, half_day boolean, days numeric, status text)
language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := public.my_employee_id(p_company); v_all boolean; v_dept uuid;
begin
  if not public.is_member(p_company) then raise exception 'Not a member of this company' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 92 then raise exception 'Choose a range of up to 3 months'; end if;
  v_all := public.has_permission(p_company, 'leave.view') or public.has_permission(p_company, 'leave.approve');
  select department_id into v_dept from public.employees where id = v_me;
  return query
  select r.id, e.id, trim(e.first_name || ' ' || e.last_name), e.employee_code, d.name, lt.name, lt.color,
    r.start_date, r.end_date, r.half_day, r.days, r.status
  from public.leave_requests r
  join public.employees e on e.id = r.employee_id
  join public.leave_types lt on lt.id = r.leave_type_id
  left join public.departments d on d.id = e.department_id
  where r.company_id = p_company
    and r.start_date <= p_to and r.end_date >= p_from
    and (p_department is null or e.department_id = p_department)
    and (
      (v_all and r.status in ('approved','pending'))
      or (r.employee_id = v_me and r.status in ('approved','pending'))
      or (e.manager_id = v_me and v_me is not null and r.status in ('approved','pending'))
      or (r.status = 'approved' and v_dept is not null and e.department_id = v_dept)
    )
  order by r.start_date, e.first_name;
end $$;
