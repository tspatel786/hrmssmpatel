-- =====================================================================
-- 2000  RESIGNATION & EXIT, DOCUMENT MANAGEMENT, DAILY JOBS, OVERVIEW DASHBOARDS
-- A. notifications: several generic notifications to one person in one transaction are all emailed (only a
--    dedicated email from the same operation suppresses the generic copy)
-- B. leave: rejecting a request requires a reason
-- C. resignation: employee -> reporting manager -> HR -> notice period -> exit checklist -> settlement ->
--    exit letters -> exit completed -> access deactivated the day after the last working day
-- D. documents: verification status, rejection reason, expiry, self-upload, history; company documents
-- E. daily jobs (once per company per day, run by the email worker): absentees, notice reminders,
--    document expiry reminders, post-exit deactivation
-- F. overview RPCs for HR / manager / employee dashboards; exit and document reports
-- No table is dropped, no data is deleted, no policy is loosened.
-- =====================================================================

-- ---------- A. notification email dedupe ----------
create or replace function public.email_notification() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_email text; v_name text;
begin
  select p.email, p.full_name into v_email, v_name from public.profiles p where p.id = new.user_id;
  if v_email is null then return null; end if;
  -- a dedicated email (leave decision, payslip, interviewer assigned…) sent by the same operation already covers it
  if exists (select 1 from public.email_logs l where l.company_id = new.company_id and lower(l.to_email) = lower(v_email)
             and l.created_at = now() and l.template_key <> 'notification') then
    return null;
  end if;
  perform public.enqueue_email(new.company_id, 'notification', v_email, v_name,
    jsonb_build_object('title', new.title, 'body', coalesce(new.body, ''),
      'link_url', public.app_url() || coalesce(new.link, '/app')),
    'notification:' || new.id, 'notifications', new.id);
  return null;
end $$;

-- ---------- B. leave rejection needs a reason ----------
create or replace function public.decide_leave(p_request uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.leave_requests; e public.employees; lt public.leave_types; b public.leave_balances; d date;
begin
  select * into r from public.leave_requests where id = p_request for update;
  if r.id is null then raise exception 'Leave request not found'; end if;
  if not public.can_approve_leave(r.id) then raise exception 'You are not allowed to decide this leave request' using errcode = '42501'; end if;
  if r.status <> 'pending' then raise exception 'This request has already been %', r.status; end if;
  if not p_approve and char_length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Give a reason for rejecting the leave request'; end if;
  select * into e from public.employees where id = r.employee_id;
  select * into lt from public.leave_types where id = r.leave_type_id;

  if p_approve then
    if lt.is_paid then
      b := public.ensure_leave_balance(r.company_id, r.employee_id, r.leave_type_id, extract(year from r.start_date)::int);
      if b.allocated - b.used < r.days then raise exception 'Insufficient balance to approve (% available)', b.allocated - b.used; end if;
      update public.leave_balances set used = used + r.days where id = b.id;
    end if;
    for d in select * from public.working_dates(r.company_id, r.start_date, r.end_date) loop
      insert into public.attendance_records (company_id, employee_id, attendance_date, status, source, notes)
      values (r.company_id, r.employee_id, d, case when r.half_day then 'half_day' else 'on_leave' end, 'system', lt.name)
      on conflict (employee_id, attendance_date) do update set status = excluded.status, notes = excluded.notes
        where public.attendance_records.check_in is null or excluded.status = 'half_day';
    end loop;
  end if;

  update public.leave_requests set status = case when p_approve then 'approved' else 'rejected' end,
    approver_id = auth.uid(), decided_at = now(), decision_note = p_note where id = r.id;

  perform public.notify_user(r.company_id, e.user_id, 'leave',
    'Leave ' || case when p_approve then 'approved' else 'rejected' end,
    lt.name || ' · ' || public.fmt_date(r.start_date) || ' – ' || public.fmt_date(r.end_date), '/app/leave');
  perform public.enqueue_email(r.company_id, 'leave_decision', e.email, trim(e.first_name || ' ' || e.last_name),
    jsonb_build_object('employee_name', trim(e.first_name || ' ' || e.last_name), 'leave_type', lt.name,
      'start_date', public.fmt_date(r.start_date), 'end_date', public.fmt_date(r.end_date), 'days', r.days::text,
      'decision', case when p_approve then 'approved' else 'rejected' end, 'note', coalesce(p_note, '')),
    'leave:' || r.id || ':decision', 'leave_requests', r.id);
end $$;

-- ---------- C. resignation & exit ----------
alter table public.companies add column if not exists notice_period_days integer not null default 30
  check (notice_period_days between 0 and 180);

create table if not exists public.resignations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  status text not null default 'pending_manager'
    check (status in ('pending_manager','pending_hr','approved','rejected','withdrawn','completed')),
  reason text not null check (char_length(reason) between 10 and 3000),
  resigned_on date not null,
  proposed_last_day date not null,
  approved_last_day date,
  manager_user_id uuid references auth.users(id) on delete set null,
  manager_comment text check (char_length(manager_comment) <= 2000),
  manager_decided_at timestamptz,
  hr_comment text check (char_length(hr_comment) <= 2000),
  hr_decided_by uuid references auth.users(id) on delete set null,
  hr_decided_at timestamptz,
  withdrawal_requested boolean not null default false,
  withdrawal_reason text check (char_length(withdrawal_reason) <= 2000),
  settlement_status text not null default 'pending' check (settlement_status in ('pending','processing','paid','not_applicable')),
  settlement_amount numeric(14,2) check (settlement_amount >= 0),
  settlement_note text check (char_length(settlement_note) <= 2000),
  completed_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists resignations_company_idx on public.resignations (company_id, status);
create unique index if not exists resignations_one_active on public.resignations (employee_id)
  where status in ('pending_manager','pending_hr','approved');
drop trigger if exists trg_resignations_updated on public.resignations;
create trigger trg_resignations_updated before update on public.resignations for each row execute function public.set_updated_at();
drop trigger if exists trg_audit_resignations on public.resignations;
create trigger trg_audit_resignations after insert or update or delete on public.resignations
  for each row execute function public.audit_trigger();
alter table public.resignations enable row level security;
-- employee: own; reporting manager: their direct reports; HR (employees.view): all in the company. Writes go through RPCs.
drop policy if exists "read resignations" on public.resignations;
create policy "read resignations" on public.resignations for select to authenticated using (
  public.has_permission(company_id, 'employees.view')
  or employee_id = public.my_employee_id(company_id)
  or exists (select 1 from public.employees e join public.employees m on m.id = e.manager_id
             where e.id = resignations.employee_id and m.user_id = auth.uid()));
grant select on public.resignations to authenticated;
revoke all on public.resignations from anon;

create table if not exists public.exit_tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  resignation_id uuid not null references public.resignations(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 120),
  category text not null default 'hr' check (category in ('assets','documents','access','finance','hr','knowledge')),
  is_completed boolean not null default false,
  note text check (char_length(note) <= 500),
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists exit_tasks_idx on public.exit_tasks (resignation_id, sort_order);
alter table public.exit_tasks enable row level security;
drop policy if exists "read exit tasks" on public.exit_tasks;
create policy "read exit tasks" on public.exit_tasks for select to authenticated using (
  public.has_permission(company_id, 'employees.view')
  or exists (select 1 from public.resignations r where r.id = resignation_id and r.employee_id = public.my_employee_id(r.company_id)));
drop policy if exists "hr manage exit tasks" on public.exit_tasks;
create policy "hr manage exit tasks" on public.exit_tasks for all to authenticated
  using (public.has_permission(company_id, 'employees.manage'))
  with check (public.has_permission(company_id, 'employees.manage')
              and exists (select 1 from public.resignations r where r.id = resignation_id and r.company_id = exit_tasks.company_id
                          and r.status = 'approved'));
grant select, insert, update, delete on public.exit_tasks to authenticated;
revoke all on public.exit_tasks from anon;

create or replace function public.exit_task_touch() returns trigger
language plpgsql as $$
begin
  if new.is_completed and not coalesce(old.is_completed, false) then new.completed_by := auth.uid(); new.completed_at := now();
  elsif not new.is_completed then new.completed_by := null; new.completed_at := null; end if;
  return new;
end $$;
drop trigger if exists trg_exit_task_touch on public.exit_tasks;
create trigger trg_exit_task_touch before insert or update on public.exit_tasks for each row execute function public.exit_task_touch();

create or replace view public.v_resignations with (security_invoker = true) as
select r.*, trim(e.first_name || ' ' || coalesce(e.last_name, '')) as employee_name, e.employee_code, e.email as employee_email,
  e.status as employee_status, d.name as department_name, g.title as designation_title, e.joining_date,
  trim(m.first_name || ' ' || coalesce(m.last_name, '')) as manager_name,
  case when r.status = 'approved' then (coalesce(r.approved_last_day, r.proposed_last_day) - (now() at time zone public.company_tz(r.company_id))::date) end as days_left,
  (select count(*) from public.exit_tasks t where t.resignation_id = r.id)::int as tasks_total,
  (select count(*) from public.exit_tasks t where t.resignation_id = r.id and t.is_completed)::int as tasks_done
from public.resignations r
join public.employees e on e.id = r.employee_id
left join public.departments d on d.id = e.department_id
left join public.designations g on g.id = e.designation_id
left join public.employees m on m.id = e.manager_id;
grant select on public.v_resignations to authenticated;

create or replace function public.resignation_people(p_resignation uuid)
returns table (employee_user uuid, employee_name text, employee_email text, manager_user uuid, company_id uuid)
language sql stable security definer set search_path = public as $$
  select e.user_id, trim(e.first_name || ' ' || coalesce(e.last_name, '')), e.email, r.manager_user_id, r.company_id
  from public.resignations r join public.employees e on e.id = r.employee_id where r.id = p_resignation
$$;
revoke execute on function public.resignation_people(uuid) from public, anon, authenticated;

create or replace function public.submit_resignation(p_company uuid, p_reason text, p_last_day date) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); e public.employees; v_mgr uuid; v_id uuid;
  v_today date := (now() at time zone public.company_tz(p_company))::date; v_name text;
begin
  if v_emp is null then raise exception 'Your account is not linked to an employee profile'; end if;
  select * into e from public.employees where id = v_emp;
  if e.status in ('inactive', 'terminated') then raise exception 'Your employment has already ended'; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'Please explain the reason (at least 10 characters)'; end if;
  if p_last_day is null or p_last_day < v_today then raise exception 'The last working day cannot be in the past'; end if;
  if p_last_day > v_today + 365 then raise exception 'The last working day must be within a year'; end if;
  if exists (select 1 from public.resignations where employee_id = v_emp and status in ('pending_manager','pending_hr','approved')) then
    raise exception 'You already have an active resignation' using errcode = '23505';
  end if;
  select m.user_id into v_mgr from public.employees m where m.id = e.manager_id and m.status not in ('inactive','terminated');
  insert into public.resignations (company_id, employee_id, status, reason, resigned_on, proposed_last_day, manager_user_id)
  values (p_company, v_emp, case when v_mgr is null or v_mgr = auth.uid() then 'pending_hr' else 'pending_manager' end,
          trim(p_reason), v_today, p_last_day, v_mgr)
  returning id into v_id;
  v_name := trim(e.first_name || ' ' || coalesce(e.last_name, ''));
  if v_mgr is not null and v_mgr <> auth.uid() then
    perform public.notify_user(p_company, v_mgr, 'resignation', 'Resignation from ' || v_name,
      v_name || ' resigned. Proposed last working day: ' || public.fmt_date(p_last_day) || '. Please review.', '/app/exits/' || v_id);
  else
    perform public.notify_permission(p_company, 'employees.manage', 'resignation', 'Resignation from ' || v_name,
      v_name || ' resigned. Proposed last working day: ' || public.fmt_date(p_last_day) || '.', '/app/exits/' || v_id);
  end if;
  perform public.notify_user(p_company, auth.uid(), 'resignation', 'Resignation submitted',
    'Your resignation was submitted. Proposed last working day: ' || public.fmt_date(p_last_day) || '.', '/app/exits/' || v_id);
  return v_id;
end $$;
revoke execute on function public.submit_resignation(uuid, text, date) from public, anon;
grant execute on function public.submit_resignation(uuid, text, date) to authenticated;

create or replace function public.decide_resignation_manager(p_resignation uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resignations; pp record;
begin
  select * into r from public.resignations where id = p_resignation for update;
  if r.id is null then raise exception 'Resignation not found'; end if;
  if r.status <> 'pending_manager' then raise exception 'This resignation is not waiting for the manager'; end if;
  if r.manager_user_id is distinct from auth.uid() then raise exception 'Only the reporting manager can decide this step' using errcode = '42501'; end if;
  if not p_approve and char_length(trim(coalesce(p_comment, ''))) < 3 then raise exception 'Give a reason for rejecting'; end if;
  update public.resignations set status = case when p_approve then 'pending_hr' else 'rejected' end,
    manager_comment = nullif(trim(coalesce(p_comment, '')), ''), manager_decided_at = now() where id = r.id;
  select * into pp from public.resignation_people(r.id);
  perform public.notify_user(r.company_id, pp.employee_user, 'resignation',
    'Resignation ' || case when p_approve then 'approved by your manager' else 'not accepted by your manager' end,
    coalesce('Manager: ' || nullif(trim(coalesce(p_comment, '')), ''), case when p_approve then 'It now goes to HR for final approval.' else '' end),
    '/app/exits/' || r.id);
  if p_approve then
    perform public.notify_permission(r.company_id, 'employees.manage', 'resignation', 'Resignation awaiting HR approval: ' || pp.employee_name,
      'Approved by the reporting manager. Proposed last working day: ' || public.fmt_date(r.proposed_last_day) || '.', '/app/exits/' || r.id);
  end if;
end $$;
revoke execute on function public.decide_resignation_manager(uuid, boolean, text) from public, anon;
grant execute on function public.decide_resignation_manager(uuid, boolean, text) to authenticated;

create or replace function public.decide_resignation_hr(p_resignation uuid, p_approve boolean, p_comment text default null, p_last_day date default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resignations; pp record; v_last date;
begin
  select * into r from public.resignations where id = p_resignation for update;
  if r.id is null then raise exception 'Resignation not found'; end if;
  perform public.require_permission(r.company_id, 'employees.manage');
  if r.status <> 'pending_hr' then raise exception 'This resignation is not waiting for HR'; end if;
  if r.employee_id = public.my_employee_id(r.company_id) then raise exception 'You cannot approve your own resignation'; end if;
  if not p_approve and char_length(trim(coalesce(p_comment, ''))) < 3 then raise exception 'Give a reason for rejecting'; end if;
  v_last := coalesce(p_last_day, r.proposed_last_day);
  if p_approve and v_last < r.resigned_on then raise exception 'The last working day cannot be before the resignation date'; end if;
  update public.resignations set status = case when p_approve then 'approved' else 'rejected' end,
    approved_last_day = case when p_approve then v_last end,
    hr_comment = nullif(trim(coalesce(p_comment, '')), ''), hr_decided_by = auth.uid(), hr_decided_at = now() where id = r.id;
  select * into pp from public.resignation_people(r.id);
  if p_approve then
    update public.employees set status = 'notice', exit_date = v_last where id = r.employee_id;
    insert into public.exit_tasks (company_id, resignation_id, title, category, sort_order) values
      (r.company_id, r.id, 'Knowledge transfer / handover completed', 'knowledge', 1),
      (r.company_id, r.id, 'Laptop, ID card and other company assets returned', 'assets', 2),
      (r.company_id, r.id, 'Company documents and files returned', 'documents', 3),
      (r.company_id, r.id, 'Email, software and system access revoked', 'access', 4),
      (r.company_id, r.id, 'Pending reimbursements and dues cleared', 'finance', 5),
      (r.company_id, r.id, 'Exit interview completed', 'hr', 6);
  end if;
  perform public.notify_user(r.company_id, pp.employee_user, 'resignation',
    'Resignation ' || case when p_approve then 'approved' else 'not accepted' end || ' by HR',
    case when p_approve then 'Your last working day is ' || public.fmt_date(v_last) || '. HR will guide you through the exit checklist.'
         else 'HR: ' || trim(p_comment) end, '/app/exits/' || r.id);
  if pp.manager_user is not null then
    perform public.notify_user(r.company_id, pp.manager_user, 'resignation',
      'Resignation ' || case when p_approve then 'approved' else 'rejected' end || ' by HR: ' || pp.employee_name,
      case when p_approve then 'Last working day: ' || public.fmt_date(v_last) || '.' else coalesce(trim(p_comment), '') end, '/app/exits/' || r.id);
  end if;
end $$;
revoke execute on function public.decide_resignation_hr(uuid, boolean, text, date) from public, anon;
grant execute on function public.decide_resignation_hr(uuid, boolean, text, date) to authenticated;

-- employee withdraws: immediate while pending; after approval it becomes a request HR decides
create or replace function public.withdraw_resignation(p_resignation uuid, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare r public.resignations; pp record;
begin
  select * into r from public.resignations where id = p_resignation for update;
  if r.id is null or r.employee_id is distinct from public.my_employee_id(r.company_id) then raise exception 'Resignation not found'; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please give a reason'; end if;
  select * into pp from public.resignation_people(r.id);
  if r.status in ('pending_manager', 'pending_hr') then
    update public.resignations set status = 'withdrawn', withdrawal_reason = trim(p_reason) where id = r.id;
    if r.status = 'pending_manager' and pp.manager_user is not null then
      perform public.notify_user(r.company_id, pp.manager_user, 'resignation', 'Resignation withdrawn: ' || pp.employee_name, trim(p_reason), '/app/exits/' || r.id);
    else
      perform public.notify_permission(r.company_id, 'employees.manage', 'resignation', 'Resignation withdrawn: ' || pp.employee_name, trim(p_reason), '/app/exits/' || r.id);
    end if;
    return 'withdrawn';
  elsif r.status = 'approved' then
    if r.withdrawal_requested then raise exception 'A withdrawal request is already waiting for HR'; end if;
    update public.resignations set withdrawal_requested = true, withdrawal_reason = trim(p_reason) where id = r.id;
    perform public.notify_permission(r.company_id, 'employees.manage', 'resignation', 'Resignation cancellation requested: ' || pp.employee_name,
      trim(p_reason), '/app/exits/' || r.id);
    return 'requested';
  end if;
  raise exception 'This resignation can no longer be withdrawn';
end $$;
revoke execute on function public.withdraw_resignation(uuid, text) from public, anon;
grant execute on function public.withdraw_resignation(uuid, text) to authenticated;

create or replace function public.decide_resignation_withdrawal(p_resignation uuid, p_approve boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resignations; e public.employees; pp record;
begin
  select * into r from public.resignations where id = p_resignation for update;
  if r.id is null then raise exception 'Resignation not found'; end if;
  perform public.require_permission(r.company_id, 'employees.manage');
  if r.status <> 'approved' or not r.withdrawal_requested then raise exception 'No cancellation request is waiting'; end if;
  if not p_approve and char_length(trim(coalesce(p_comment, ''))) < 3 then raise exception 'Give a reason for rejecting'; end if;
  select * into pp from public.resignation_people(r.id);
  if p_approve then
    select * into e from public.employees where id = r.employee_id;
    update public.resignations set status = 'withdrawn', withdrawal_requested = false,
      hr_comment = coalesce(nullif(trim(coalesce(p_comment, '')), ''), hr_comment) where id = r.id;
    update public.employees set exit_date = null,
      status = case when e.probation_end_date is not null and e.probation_end_date > (now() at time zone public.company_tz(r.company_id))::date then 'probation' else 'active' end
    where id = r.employee_id;
  else
    update public.resignations set withdrawal_requested = false where id = r.id;
  end if;
  perform public.notify_user(r.company_id, pp.employee_user, 'resignation',
    'Resignation cancellation ' || case when p_approve then 'approved – you continue with us' else 'not approved' end,
    coalesce(nullif(trim(coalesce(p_comment, '')), ''), ''), '/app/exits/' || r.id);
end $$;
revoke execute on function public.decide_resignation_withdrawal(uuid, boolean, text) from public, anon;
grant execute on function public.decide_resignation_withdrawal(uuid, boolean, text) to authenticated;

create or replace function public.set_exit_settlement(p_resignation uuid, p_status text, p_amount numeric default null, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resignations;
begin
  select * into r from public.resignations where id = p_resignation for update;
  if r.id is null then raise exception 'Resignation not found'; end if;
  perform public.require_permission(r.company_id, 'employees.manage');
  if r.status not in ('approved', 'completed') then raise exception 'Settlement is recorded for approved resignations only'; end if;
  if p_status not in ('pending','processing','paid','not_applicable') then raise exception 'Invalid settlement status'; end if;
  update public.resignations set settlement_status = p_status, settlement_amount = p_amount,
    settlement_note = nullif(trim(coalesce(p_note, '')), '') where id = r.id;
end $$;
revoke execute on function public.set_exit_settlement(uuid, text, numeric, text) from public, anon;
grant execute on function public.set_exit_settlement(uuid, text, numeric, text) to authenticated;

-- deactivation: employee inactive, login membership inactive (they can no longer open the company)
create or replace function public.deactivate_exited_employee(p_resignation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resignations; e public.employees;
begin
  select * into r from public.resignations where id = p_resignation for update;
  select * into e from public.employees where id = r.employee_id for update;
  if r.deactivated_at is not null then return; end if;
  update public.employees set status = 'inactive', exit_date = coalesce(r.approved_last_day, r.proposed_last_day) where id = e.id;
  update public.company_members set status = 'inactive' where company_id = r.company_id and (employee_id = e.id or (e.user_id is not null and user_id = e.user_id));
  update public.resignations set deactivated_at = now() where id = r.id;
  perform public.notify_permission(r.company_id, 'employees.manage', 'resignation',
    'Exit completed: ' || trim(e.first_name || ' ' || coalesce(e.last_name, '')),
    e.employee_code || ' is now inactive and their HRMS access is closed.', '/app/exits/' || r.id);
end $$;
revoke execute on function public.deactivate_exited_employee(uuid) from public, anon, authenticated;

create or replace function public.complete_exit(p_resignation uuid) returns text
language plpgsql security definer set search_path = public as $$
declare r public.resignations; pp record; v_open text; v_today date;
begin
  select * into r from public.resignations where id = p_resignation for update;
  if r.id is null then raise exception 'Resignation not found'; end if;
  perform public.require_permission(r.company_id, 'employees.manage');
  if r.status <> 'approved' then raise exception 'Only approved resignations can be completed'; end if;
  if r.withdrawal_requested then raise exception 'Decide the cancellation request first'; end if;
  select string_agg(title, ', ' order by sort_order) into v_open from public.exit_tasks where resignation_id = r.id and not is_completed;
  if v_open is not null then raise exception 'Complete the exit checklist first: %', v_open; end if;
  if r.settlement_status in ('pending', 'processing') then raise exception 'Record the final settlement as paid or not applicable first'; end if;
  update public.resignations set status = 'completed', completed_at = now() where id = r.id;
  select * into pp from public.resignation_people(r.id);
  perform public.notify_user(r.company_id, pp.employee_user, 'resignation', 'Exit formalities completed',
    'Thank you for your contributions. Your HRMS access stays open until ' || public.fmt_date(coalesce(r.approved_last_day, r.proposed_last_day)) || '.',
    '/app/exits/' || r.id);
  v_today := (now() at time zone public.company_tz(r.company_id))::date;
  if coalesce(r.approved_last_day, r.proposed_last_day) < v_today then
    perform public.deactivate_exited_employee(r.id);
    return 'deactivated';
  end if;
  return 'completed';
end $$;
revoke execute on function public.complete_exit(uuid) from public, anon;
grant execute on function public.complete_exit(uuid) to authenticated;

-- ---------- D. documents ----------
do $$
declare v_con text;
begin
  select conname into v_con from pg_constraint
  where conrelid = 'public.employee_documents'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%doc_type%';
  if v_con is not null then execute format('alter table public.employee_documents drop constraint %I', v_con); end if;
  alter table public.employee_documents add constraint employee_documents_doc_type_check
    check (doc_type in ('id_proof','aadhaar','pan','address_proof','personal','education','experience','contract','nda','agreement',
                        'offer_letter','appointment_letter','relieving_letter','experience_letter','salary_slip','tax','other'));
end $$;
alter table public.employee_documents add column if not exists status text not null default 'verified'
  check (status in ('pending','verified','rejected'));
alter table public.employee_documents add column if not exists rejection_reason text check (char_length(rejection_reason) <= 500);
alter table public.employee_documents add column if not exists expiry_date date;
alter table public.employee_documents add column if not exists verified_by uuid references auth.users(id) on delete set null;
alter table public.employee_documents add column if not exists verified_at timestamptz;

-- employees upload their own documents (status pending) under <company>/employees/<me>/self/…
drop policy if exists "employees add own documents" on public.employee_documents;
create policy "employees add own documents" on public.employee_documents for insert to authenticated with check (
  employee_id = public.my_employee_id(company_id) and status = 'pending' and verified_by is null
  and doc_type in ('id_proof','aadhaar','pan','address_proof','personal','education','experience','tax','other')
  and storage_path like company_id::text || '/employees/' || employee_id::text || '/self/%');
drop policy if exists "employees remove own unverified documents" on public.employee_documents;
create policy "employees remove own unverified documents" on public.employee_documents for delete to authenticated using (
  employee_id = public.my_employee_id(company_id) and status <> 'verified' and uploaded_by = auth.uid());
grant select, insert, update, delete on public.employee_documents to authenticated;

create or replace function public.self_document_path_ok(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select split_part(p_name, '/', 2) = 'employees' and split_part(p_name, '/', 4) = 'self'
     and public.try_uuid(split_part(p_name, '/', 3)) = public.my_employee_id(public.storage_company(p_name))
     and p_name not like '%..%'
$$;
grant execute on function public.self_document_path_ok(text) to authenticated;
drop policy if exists "employees upload own documents" on storage.objects;
create policy "employees upload own documents" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.self_document_path_ok(name));
drop policy if exists "employees delete own unverified files" on storage.objects;
create policy "employees delete own unverified files" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.self_document_path_ok(name)
         and not exists (select 1 from public.employee_documents d where d.storage_path = name and d.status = 'verified'));

create or replace function public.verify_employee_document(p_document uuid, p_approve boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.employee_documents; e public.employees;
begin
  select * into d from public.employee_documents where id = p_document for update;
  if d.id is null then raise exception 'Document not found'; end if;
  perform public.require_permission(d.company_id, 'employees.manage');
  if d.employee_id = public.my_employee_id(d.company_id) then raise exception 'You cannot verify your own document'; end if;
  if not p_approve and char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason so the employee knows what to fix'; end if;
  update public.employee_documents set status = case when p_approve then 'verified' else 'rejected' end,
    rejection_reason = case when p_approve then null else trim(p_reason) end, verified_by = auth.uid(), verified_at = now()
  where id = d.id;
  select * into e from public.employees where id = d.employee_id;
  perform public.notify_user(d.company_id, e.user_id, 'document',
    'Document ' || case when p_approve then 'verified' else 'rejected' end || ': ' || d.file_name,
    case when p_approve then 'HR verified your document.' else 'Reason: ' || trim(p_reason) || '. Please upload a corrected copy.' end,
    '/app/documents');
end $$;
revoke execute on function public.verify_employee_document(uuid, boolean, text) from public, anon;
grant execute on function public.verify_employee_document(uuid, boolean, text) to authenticated;

-- notify HR when an employee uploads a document for verification
create or replace function public.on_employee_document_added() returns trigger
language plpgsql security definer set search_path = public as $$
declare e public.employees;
begin
  if new.status = 'pending' then
    select * into e from public.employees where id = new.employee_id;
    perform public.notify_permission(new.company_id, 'employees.manage', 'document',
      'Document to verify: ' || trim(e.first_name || ' ' || coalesce(e.last_name, '')),
      new.file_name || ' (' || replace(new.doc_type, '_', ' ') || ')', '/app/documents?tab=verify');
  end if;
  return new;
end $$;
drop trigger if exists trg_employee_document_added on public.employee_documents;
create trigger trg_employee_document_added after insert on public.employee_documents
  for each row execute function public.on_employee_document_added();

-- history from the audit trail, for people allowed to see the document
create or replace function public.document_history(p_document uuid)
returns table (action text, changed_fields text[], status text, actor_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_company uuid; v_emp uuid;
begin
  select d.company_id, d.employee_id into v_company, v_emp from public.employee_documents d where d.id = p_document;
  if v_company is null then  -- deleted document: identify it from its last audit entry
    select (a.old_data ->> 'company_id')::uuid, (a.old_data ->> 'employee_id')::uuid into v_company, v_emp
    from public.audit_logs a where a.table_name = 'employee_documents' and a.record_id = p_document order by a.created_at desc limit 1;
  end if;
  if v_company is null or not (public.has_permission(v_company, 'employees.view') or v_emp = public.my_employee_id(v_company)) then
    raise exception 'Document not found';
  end if;
  return query
  select a.action, a.changed_fields, coalesce(a.new_data ->> 'status', a.old_data ->> 'status'), p.full_name, a.created_at
  from public.audit_logs a left join public.profiles p on p.id = a.actor_id
  where a.table_name = 'employee_documents' and a.record_id = p_document and a.company_id = v_company order by a.created_at;
end $$;
revoke execute on function public.document_history(uuid) from public, anon;
grant execute on function public.document_history(uuid) to authenticated;

create table if not exists public.company_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 150),
  category text not null default 'policy' check (category in ('policy','handbook','form','agreement','certificate','other')),
  visibility text not null default 'all' check (visibility in ('all','hr')),
  file_name text not null check (char_length(file_name) between 1 and 200),
  storage_path text not null,
  mime_type text,
  size_bytes bigint check (size_bytes between 0 and 10485760),
  expiry_date date,
  uploaded_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (storage_path like company_id::text || '/company/%')
);
create index if not exists company_documents_idx on public.company_documents (company_id, category);
drop trigger if exists trg_audit_company_documents on public.company_documents;
create trigger trg_audit_company_documents after insert or update or delete on public.company_documents
  for each row execute function public.audit_trigger();
alter table public.company_documents enable row level security;
drop policy if exists "read company documents" on public.company_documents;
create policy "read company documents" on public.company_documents for select to authenticated using (
  public.has_permission(company_id, 'settings.manage') or public.has_permission(company_id, 'employees.manage')
  or (visibility = 'all' and public.is_member(company_id)));
drop policy if exists "admins manage company documents" on public.company_documents;
create policy "admins manage company documents" on public.company_documents for all to authenticated
  using (public.has_permission(company_id, 'settings.manage')) with check (public.has_permission(company_id, 'settings.manage'));
grant select, insert, update, delete on public.company_documents to authenticated;
revoke all on public.company_documents from anon;

create or replace function public.can_access_document(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'offers' then public.has_permission(public.storage_company(p_name), case when p_write then 'offers.manage' else 'offers.view' end)
    when 'employees' then public.has_permission(public.storage_company(p_name), case when p_write then 'employees.manage' else 'employees.view' end)
                          or (not p_write and public.try_uuid(split_part(p_name, '/', 3)) = public.my_employee_id(public.storage_company(p_name)))
    when 'candidates' then public.has_permission(public.storage_company(p_name), case when p_write then 'candidates.manage' else 'candidates.view' end)
    when 'onboarding' then public.has_permission(public.storage_company(p_name), case when p_write then 'onboarding.manage' else 'onboarding.view' end)
    when 'company' then public.has_permission(public.storage_company(p_name), 'settings.manage')
                        or (not p_write and exists (select 1 from public.company_documents d where d.storage_path = p_name
                              and (public.has_permission(d.company_id, 'employees.manage') or (d.visibility = 'all' and public.is_member(d.company_id)))))
    else false end
$$;

create or replace function public.send_exit_letter(p_employee uuid, p_path text, p_kind text, p_file_name text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.employees; v_size bigint; v_label text;
begin
  if p_kind not in ('relieving_letter', 'experience_letter') then raise exception 'Unknown letter type'; end if;
  select * into e from public.employees where id = p_employee;
  if e.id is null then raise exception 'Employee not found'; end if;
  perform public.require_permission(e.company_id, 'employees.manage');
  if p_path is null or p_path not like e.company_id::text || '/employees/' || e.id::text || '/%' or p_path like '%..%' then
    raise exception 'Invalid letter file';
  end if;
  select (metadata ->> 'size')::bigint into v_size from storage.objects where bucket_id = 'documents' and name = p_path;
  if not found then raise exception 'Letter upload not found'; end if;
  v_label := case p_kind when 'relieving_letter' then 'Relieving letter' else 'Experience letter' end;
  insert into public.employee_documents (company_id, employee_id, doc_type, file_name, storage_path, mime_type, size_bytes, status, verified_by, verified_at)
  values (e.company_id, e.id, p_kind, left(p_file_name, 200), p_path, 'application/pdf', v_size, 'verified', auth.uid(), now());
  perform public.enqueue_email(e.company_id, 'exit_letter', e.email, trim(e.first_name || ' ' || coalesce(e.last_name, '')),
    jsonb_build_object('employee_name', trim(e.first_name || ' ' || coalesce(e.last_name, '')), 'letter_name', v_label,
      'employee_code', e.employee_code, 'last_day', public.fmt_date(e.exit_date)),
    'exit-letter:' || e.id || ':' || md5(p_path), 'employees', e.id,
    jsonb_build_array(jsonb_build_object('bucket', 'documents', 'path', p_path, 'filename', left(p_file_name, 200))));
end $$;
revoke execute on function public.send_exit_letter(uuid, text, text, text) from public, anon;
grant execute on function public.send_exit_letter(uuid, text, text, text) to authenticated;

create or replace function public.seed_exit_templates(p_company uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.email_templates (company_id, key, name, description, subject, body_html) values
  (p_company, 'exit_letter', 'Exit letter', 'Sent with the relieving or experience letter PDF',
   'Your {{letter_name}} — {{company_name}}',
   '<p>Hi {{employee_name}},</p><p>Please find attached your <strong>{{letter_name}}</strong> (Employee ID {{employee_code}}, last working day {{last_day}}).</p><p>We thank you for your contributions and wish you every success.</p>')
  on conflict (company_id, key) do nothing
$$;
revoke execute on function public.seed_exit_templates(uuid) from public, anon, authenticated;
select public.seed_exit_templates(id) from public.companies;
create or replace function public.on_company_created_exit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_exit_templates(new.id);
  return new;
end $$;
drop trigger if exists trg_company_created_exit on public.companies;
create trigger trg_company_created_exit after insert on public.companies for each row execute function public.on_company_created_exit();

-- ---------- E. daily jobs ----------
create table if not exists public.daily_job_runs (
  company_id uuid not null references public.companies(id) on delete cascade,
  run_on date not null,
  ran_at timestamptz not null default now(),
  primary key (company_id, run_on)
);
alter table public.daily_job_runs enable row level security;
revoke all on public.daily_job_runs from public, anon, authenticated;

-- absent = a past working day (not a holiday) with no attendance record, for employees employed that day
create or replace function public.mark_absentees(p_company uuid, p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  insert into public.attendance_records (company_id, employee_id, attendance_date, status, source, notes)
  select p_company, e.id, d, 'absent', 'system', 'No attendance recorded'
  from public.employees e cross join lateral public.working_dates(p_company, greatest(p_from, e.joining_date), p_to) d
  where e.company_id = p_company and e.status in ('active', 'probation', 'notice')
    and (e.exit_date is null or d <= e.exit_date)
  on conflict (employee_id, attendance_date) do nothing;
  get diagnostics v = row_count;
  return v;
end $$;
revoke execute on function public.mark_absentees(uuid, date, date) from public, anon, authenticated;

create or replace function public.run_daily_jobs() returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; v_today date; v_absent integer := 0; v_reminders integer := 0; v_deactivated integer := 0; r record; d record; v_days integer;
begin
  for c in select id from public.companies where status <> 'suspended' loop
    v_today := (now() at time zone public.company_tz(c.id))::date;
    insert into public.daily_job_runs (company_id, run_on) values (c.id, v_today) on conflict do nothing;
    if not found then continue; end if;   -- already ran today for this company

    v_absent := v_absent + public.mark_absentees(c.id, v_today - 7, v_today - 1);

    -- notice period reminders: 7 days and 1 day before the last working day
    for r in select x.*, coalesce(x.approved_last_day, x.proposed_last_day) as last_day from public.resignations x
             where x.company_id = c.id and x.status in ('approved', 'completed') and x.deactivated_at is null loop
      v_days := r.last_day - v_today;
      if v_days in (7, 1) then
        perform public.notify_permission(c.id, 'employees.manage', 'resignation',
          'Last working day in ' || v_days || ' day(s): ' || (select employee_name from public.resignation_people(r.id)),
          'Last working day ' || public.fmt_date(r.last_day) || '. Exit checklist: ' ||
          (select count(*) filter (where is_completed) || '/' || count(*) from public.exit_tasks where resignation_id = r.id) || ' done.',
          '/app/exits/' || r.id);
        perform public.notify_user(c.id, (select employee_user from public.resignation_people(r.id)), 'resignation',
          'Your last working day is in ' || v_days || ' day(s)', 'Last working day: ' || public.fmt_date(r.last_day) || '.', '/app/exits/' || r.id);
        v_reminders := v_reminders + 1;
      elsif r.status = 'completed' and r.last_day < v_today then
        perform public.deactivate_exited_employee(r.id);
        v_deactivated := v_deactivated + 1;
      end if;
    end loop;

    -- document expiry: 30 days, 7 days and on the day
    for d in select x.*, e.user_id, trim(e.first_name || ' ' || coalesce(e.last_name, '')) as emp_name
             from public.employee_documents x join public.employees e on e.id = x.employee_id
             where x.company_id = c.id and x.expiry_date - v_today in (30, 7, 0)
               and e.status not in ('inactive', 'terminated') loop
      perform public.notify_user(c.id, d.user_id, 'document',
        'Document ' || case when d.expiry_date = v_today then 'expires today' else 'expires on ' || public.fmt_date(d.expiry_date) end || ': ' || d.file_name,
        'Please upload a renewed copy.', '/app/documents');
      perform public.notify_permission(c.id, 'employees.manage', 'document',
        'Employee document expiring: ' || d.emp_name, d.file_name || ' expires on ' || public.fmt_date(d.expiry_date) || '.', '/app/documents?tab=expiring');
      v_reminders := v_reminders + 1;
    end loop;
    for d in select * from public.company_documents x where x.company_id = c.id and x.expiry_date - v_today in (30, 7, 0) loop
      perform public.notify_permission(c.id, 'settings.manage', 'document', 'Company document expiring: ' || d.title,
        'Expires on ' || public.fmt_date(d.expiry_date) || '.', '/app/documents?tab=company');
      v_reminders := v_reminders + 1;
    end loop;
  end loop;
  return jsonb_build_object('absent_marked', v_absent, 'reminders', v_reminders, 'deactivated', v_deactivated);
end $$;
revoke execute on function public.run_daily_jobs() from public, anon, authenticated;
grant execute on function public.run_daily_jobs() to service_role;

-- ---------- F. overviews and reports ----------
create or replace function public.hr_overview(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone public.company_tz(p_company))::date; v_working boolean;
begin
  if not public.has_permission(p_company, 'employees.view') then raise exception 'Permission denied' using errcode = '42501'; end if;
  v_working := exists (select 1 from public.working_dates(p_company, v_today, v_today));
  return (
    with emp as (select * from public.employees where company_id = p_company and status in ('active','probation','notice')),
    att as (select a.* from public.attendance_records a join emp on emp.id = a.employee_id where a.attendance_date = v_today)
    select jsonb_build_object(
      'total_employees', (select count(*) from emp),
      'present_today', (select count(*) from att where status in ('present','half_day')),
      'on_leave_today', (select count(*) from att where status = 'on_leave'),
      'absent_today', case when v_working then (select count(*) from emp where emp.joining_date <= v_today
                         and not exists (select 1 from att where att.employee_id = emp.id and att.status in ('present','half_day','on_leave'))) else 0 end,
      'working_day', v_working,
      'pending_leave', (select count(*) from public.leave_requests where company_id = p_company and status = 'pending'),
      'pending_resignations', (select count(*) from public.resignations where company_id = p_company and status in ('pending_manager','pending_hr')
                                 or (company_id = p_company and status = 'approved' and withdrawal_requested)),
      'on_notice', (select count(*) from public.resignations where company_id = p_company and status in ('approved','completed') and deactivated_at is null),
      'documents_to_verify', (select count(*) from public.employee_documents where company_id = p_company and status = 'pending'),
      'birthdays', coalesce((select jsonb_agg(jsonb_build_object('id', y.id, 'name', y.name, 'date', y.nb) order by y.nb) from (
          select e.id, trim(e.first_name || ' ' || coalesce(e.last_name, '')) as name,
            case when bd.this_year < v_today then (bd.this_year + interval '1 year')::date else bd.this_year end as nb
          from emp e cross join lateral (select (e.date_of_birth + make_interval(years => extract(year from age(v_today, e.date_of_birth))::int))::date as this_year) bd
          where e.date_of_birth is not null) y where y.nb - v_today <= 30), '[]'::jsonb),
      'expiring_documents', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'employee_id', x.employee_id, 'file_name', x.file_name,
            'employee_name', trim(e.first_name || ' ' || coalesce(e.last_name, '')), 'expiry_date', x.expiry_date) order by x.expiry_date)
          from public.employee_documents x join emp e on e.id = x.employee_id
          where x.expiry_date is not null and x.expiry_date <= v_today + 30), '[]'::jsonb)
    ));
end $$;
revoke execute on function public.hr_overview(uuid) from public, anon;
grant execute on function public.hr_overview(uuid) to authenticated;

create or replace function public.my_overview(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company);
begin
  if not public.is_member(p_company) then raise exception 'Not a member of this company' using errcode = '42501'; end if;
  return jsonb_build_object(
    'documents', (select jsonb_build_object('total', count(*), 'pending', count(*) filter (where status = 'pending'),
                    'rejected', count(*) filter (where status = 'rejected'),
                    'expiring', count(*) filter (where expiry_date is not null and expiry_date <= (now() at time zone public.company_tz(p_company))::date + 30))
                  from public.employee_documents where employee_id = v_emp),
    'resignation', (select to_jsonb(x) from (select r.id, r.status, r.proposed_last_day, r.approved_last_day, r.withdrawal_requested
                      from public.resignations r where r.employee_id = v_emp order by r.created_at desc limit 1) x),
    'pending_leave', (select count(*) from public.leave_requests where employee_id = v_emp and status = 'pending'),
    'team_resignations', (select count(*) from public.resignations r where r.company_id = p_company and r.status = 'pending_manager'
                            and r.manager_user_id = auth.uid()));
end $$;
revoke execute on function public.my_overview(uuid) from public, anon;
grant execute on function public.my_overview(uuid) to authenticated;

create or replace function public.report_exits(p_company uuid, p_from date, p_to date)
returns table (employee_code text, employee_name text, department text, resigned_on date, last_working_day date, status text,
               manager_comment text, hr_comment text, settlement_status text, settlement_amount numeric, tenure_months integer)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_permission(p_company, 'reports.view');
  return query
  select r.employee_code, r.employee_name, r.department_name, r.resigned_on, coalesce(r.approved_last_day, r.proposed_last_day), r.status,
    r.manager_comment, r.hr_comment, r.settlement_status, r.settlement_amount,
    ((extract(year from age(coalesce(r.approved_last_day, r.proposed_last_day), r.joining_date)) * 12)
      + extract(month from age(coalesce(r.approved_last_day, r.proposed_last_day), r.joining_date)))::int
  from public.v_resignations r where r.company_id = p_company and r.resigned_on between p_from and p_to
  order by r.resigned_on desc;
end $$;
revoke execute on function public.report_exits(uuid, date, date) from public, anon;
grant execute on function public.report_exits(uuid, date, date) to authenticated;

create or replace function public.report_documents(p_company uuid)
returns table (employee_code text, employee_name text, document text, doc_type text, status text, rejection_reason text, expiry_date date, uploaded_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_permission(p_company, 'reports.view');
  return query
  select e.employee_code, trim(e.first_name || ' ' || coalesce(e.last_name, '')), d.file_name, d.doc_type, d.status, d.rejection_reason, d.expiry_date, d.created_at
  from public.employee_documents d join public.employees e on e.id = d.employee_id
  where d.company_id = p_company order by e.employee_code, d.created_at desc;
end $$;
revoke execute on function public.report_documents(uuid) from public, anon;
grant execute on function public.report_documents(uuid) to authenticated;
