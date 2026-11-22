-- =====================================================================
-- 2100  WORKFLOW HAND-OFF FIXES (found by tests/db/workflow_gaps.test.ts)
-- 1. Go-live: automatic absences start from the day an employee was added to the HRMS, not their (older) joining date.
--    Before: adding existing staff marked them absent for the previous week, which payroll then deducted as loss of pay.
-- 2. A holiday added afterwards removes the automatic absences on that day.
-- 3. During the notice period, leave cannot end after the approved last working day.
-- 4. A resigning manager gets a "reassign direct reports" checklist item; at deactivation any remaining reports move
--    to the leaver's own manager so their approvals are never stuck with an inactive account.
-- 5. Exit: pending leave requests and attendance corrections are cancelled when access closes.
-- 6. Payroll includes employees who left during the month (status inactive with an exit date in the period).
-- 7. Hiring someone through an internal application updates their existing employee record (same Employee ID and login).
-- 8. Probation: HR and the manager are reminded 7 days before and on the end date; HR confirms or extends.
-- No table is dropped, no data is deleted, no policy is loosened.
-- =====================================================================

-- 1. absences only from the day the employee was added
create or replace function public.mark_absentees(p_company uuid, p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  insert into public.attendance_records (company_id, employee_id, attendance_date, status, source, notes)
  select p_company, e.id, d, 'absent', 'system', 'No attendance recorded'
  from public.employees e
  cross join lateral public.working_dates(p_company,
    greatest(p_from, e.joining_date, (e.created_at at time zone public.company_tz(p_company))::date + 1), p_to) d
  where e.company_id = p_company and e.status in ('active', 'probation', 'notice')
    and (e.exit_date is null or d <= e.exit_date)
  on conflict (employee_id, attendance_date) do nothing;
  get diagnostics v = row_count;
  return v;
end $$;
revoke execute on function public.mark_absentees(uuid, date, date) from public, anon, authenticated;

-- 2. holidays clear automatic absences
create or replace function public.on_holiday_added() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not new.is_optional then
    delete from public.attendance_records
    where company_id = new.company_id and attendance_date = new.holiday_date and status = 'absent' and source = 'system';
  end if;
  return new;
end $$;
drop trigger if exists trg_holiday_added on public.holidays;
create trigger trg_holiday_added after insert or update of holiday_date, is_optional on public.holidays
  for each row execute function public.on_holiday_added();

-- 3. no leave after the last working day
create or replace function public.guard_leave_after_exit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_exit date;
begin
  select exit_date into v_exit from public.employees where id = new.employee_id;
  if v_exit is not null and new.end_date > v_exit and new.status = 'pending' then
    raise exception 'Leave cannot end after your last working day (%)', public.fmt_date(v_exit);
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_leave_after_exit on public.leave_requests;
create trigger trg_guard_leave_after_exit before insert on public.leave_requests
  for each row execute function public.guard_leave_after_exit();

-- 4a. resigning manager: checklist item to reassign reports
create or replace function public.on_resignation_approved() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_reports integer;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    select count(*) into v_reports from public.employees
    where manager_id = new.employee_id and status in ('active', 'probation', 'notice');
    if v_reports > 0 then
      insert into public.exit_tasks (company_id, resignation_id, title, category, sort_order)
      values (new.company_id, new.id, 'Reassign ' || v_reports || ' direct report(s) to a new manager', 'hr', 0);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_resignation_approved on public.resignations;
create trigger trg_resignation_approved after update of status on public.resignations
  for each row execute function public.on_resignation_approved();

-- 4b + 5. deactivation: move remaining reports up, cancel pending requests
create or replace function public.deactivate_exited_employee(p_resignation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resignations; e public.employees; v_moved integer;
begin
  select * into r from public.resignations where id = p_resignation for update;
  select * into e from public.employees where id = r.employee_id for update;
  if r.deactivated_at is not null then return; end if;
  update public.employees set status = 'inactive', exit_date = coalesce(r.approved_last_day, r.proposed_last_day) where id = e.id;
  update public.company_members set status = 'inactive' where company_id = r.company_id and (employee_id = e.id or (e.user_id is not null and user_id = e.user_id));
  update public.employees set manager_id = e.manager_id where manager_id = e.id and status in ('active', 'probation', 'notice');
  get diagnostics v_moved = row_count;
  update public.leave_requests set status = 'cancelled', decision_note = 'Cancelled automatically: employee exited', decided_at = now()
    where employee_id = e.id and status = 'pending';
  update public.attendance_corrections set status = 'cancelled' where employee_id = e.id and status = 'pending';
  update public.resignations set deactivated_at = now() where id = r.id;
  perform public.notify_permission(r.company_id, 'employees.manage', 'resignation',
    'Exit completed: ' || trim(e.first_name || ' ' || coalesce(e.last_name, '')),
    e.employee_code || ' is now inactive and their HRMS access is closed.'
      || case when v_moved > 0 then ' ' || v_moved || ' direct report(s) now report to ' ||
           coalesce((select trim(m.first_name || ' ' || coalesce(m.last_name, '')) from public.employees m where m.id = e.manager_id), 'nobody — assign a manager') || '.' else '' end,
    '/app/exits/' || r.id);
end $$;
revoke execute on function public.deactivate_exited_employee(uuid) from public, anon, authenticated;

-- 6. payroll includes leavers of the month (eligible days already stop at exit_date)
create or replace function public.generate_payroll(p_company uuid, p_year integer, p_month integer) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c public.companies; v_run uuid; v_status text;
  v_start date := make_date(p_year, p_month, 1);
  v_end date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_wd integer; e record; v_elig numeric; v_lop numeric; v_paid numeric; f numeric;
  v_basic numeric; v_hra numeric; v_allow numeric; v_gross numeric; v_pf numeric; v_pt numeric; v_tds numeric; v_other numeric; v_ded numeric;
begin
  perform public.require_permission(p_company, 'payroll.manage');
  if v_start > (now() at time zone public.company_tz(p_company))::date then raise exception 'Cannot run payroll for a future month'; end if;
  select * into c from public.companies where id = p_company;
  select id, status into v_run, v_status from public.payroll_runs where company_id = p_company and period_year = p_year and period_month = p_month;
  if v_status in ('processed','paid') then raise exception 'Payroll for this month is already %', v_status; end if;
  v_wd := public.count_working_days(p_company, v_start, v_end);
  if v_wd = 0 then raise exception 'No working days in this period'; end if;
  if v_run is null then
    insert into public.payroll_runs (company_id, period_year, period_month, working_days) values (p_company, p_year, p_month, v_wd)
    returning id into v_run;
  else
    delete from public.payslips where payroll_run_id = v_run;
    update public.payroll_runs set working_days = v_wd where id = v_run;
  end if;

  for e in select * from public.employees
           where company_id = p_company and joining_date <= v_end and (exit_date is null or exit_date >= v_start)
             and (status in ('active','probation','notice') or (status = 'inactive' and exit_date is not null))
             and (basic_monthly + hra_monthly + allowances_monthly) > 0 loop
    v_elig := public.count_working_days(p_company, greatest(v_start, e.joining_date), least(v_end, coalesce(e.exit_date, v_end)));
    -- loss of pay: approved unpaid leave days + days marked absent
    select coalesce(sum(case when r.half_day then 0.5 else 1 end), 0) into v_lop
    from public.leave_requests r join public.leave_types lt on lt.id = r.leave_type_id
    cross join lateral public.working_dates(p_company, greatest(r.start_date, v_start), least(r.end_date, v_end)) d
    where r.employee_id = e.id and r.status = 'approved' and not lt.is_paid
      and r.start_date <= v_end and r.end_date >= v_start;
    v_lop := v_lop + (select count(*) from public.attendance_records a
                      where a.employee_id = e.id and a.status = 'absent' and a.attendance_date between v_start and v_end)
                   + (select count(*) * 0.5 from public.attendance_records a
                      where a.employee_id = e.id and a.status = 'half_day' and a.source <> 'system'
                        and a.attendance_date between v_start and v_end);
    v_lop := least(v_lop, v_elig);
    v_paid := v_elig - v_lop;
    f := v_paid / v_wd;
    v_basic := round(e.basic_monthly * f, 2);
    v_hra := round(e.hra_monthly * f, 2);
    v_allow := round(e.allowances_monthly * f, 2);
    v_gross := v_basic + v_hra + v_allow;
    v_pf := case when c.pf_enabled then round(v_basic * c.pf_percent / 100, 2) else 0 end;
    v_pt := case when v_gross > 0 then least(c.professional_tax, v_gross) else 0 end;
    v_tds := round(v_gross * c.tds_percent / 100, 2);
    v_other := case when v_paid > 0 then e.fixed_deductions_monthly else 0 end;
    v_ded := least(v_gross, v_pf + v_pt + v_tds + v_other);
    insert into public.payslips (company_id, payroll_run_id, employee_id, working_days, paid_days, lop_days, basic, hra, allowances,
      gross, pf, professional_tax, tds, other_deductions, total_deductions, net_pay)
    values (p_company, v_run, e.id, v_wd, v_paid, v_lop, v_basic, v_hra, v_allow, v_gross, v_pf, v_pt, v_tds, v_other, v_ded, v_gross - v_ded);
  end loop;

  update public.payroll_runs r set
    employee_count = s.n, total_gross = s.g, total_deductions = s.d, total_net = s.net
  from (select count(*) n, coalesce(sum(gross), 0) g, coalesce(sum(total_deductions), 0) d, coalesce(sum(net_pay), 0) net
        from public.payslips where payroll_run_id = v_run) s
  where r.id = v_run;
  return v_run;
end $$;


-- 7. internal transfer keeps the employee record
create or replace function public.complete_onboarding(p_onboarding uuid, p_base_url text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ob public.onboardings; o public.offers; cand public.candidates; j public.jobs; v_emp uuid; v_code text;
  v_hired integer; v_missing text;
begin
  select * into ob from public.onboardings where id = p_onboarding for update;
  if ob.id is null then raise exception 'Onboarding not found'; end if;
  perform public.require_permission(ob.company_id, 'onboarding.manage');
  if ob.status = 'completed' then raise exception 'Onboarding is already completed'; end if;
  if ob.status = 'cancelled' then raise exception 'Onboarding was cancelled'; end if;
  if not ob.joining_confirmed then raise exception 'Confirm the joining date before completing onboarding'; end if;
  select string_agg(label, ', ' order by sort_order) into v_missing from public.onboarding_documents
  where onboarding_id = ob.id and required and status <> 'verified';
  if v_missing is not null then raise exception 'Verify the required documents first: %', v_missing; end if;
  select * into o from public.offers where id = ob.offer_id;
  select * into cand from public.candidates where id = ob.candidate_id;
  select * into j from public.jobs where id = o.job_id;
  -- internal transfer / promotion: the candidate already is an employee -> update that record, keep the Employee ID and login
  select id, employee_code into v_emp, v_code from public.employees
  where company_id = ob.company_id and lower(email) = lower(cand.email) and status in ('active', 'probation', 'notice');
  if v_emp is not null then
    update public.employees set
      department_id = coalesce(o.department_id, j.department_id, department_id),
      designation_id = coalesce(o.designation_id, j.designation_id, designation_id),
      manager_id = coalesce(o.reporting_manager_id, manager_id),
      employment_type = o.employment_type, work_location = coalesce(o.work_location, j.location, work_location),
      ctc_annual = o.ctc_annual, basic_monthly = o.basic_monthly, hra_monthly = o.hra_monthly, allowances_monthly = o.allowances_monthly,
      application_id = ob.application_id
    where id = v_emp;
    update public.onboardings set status = 'completed', completed_at = now(), employee_id = v_emp where id = ob.id;
    perform set_config('hrms.stage_note', 'Internal move: ' || v_code, true);
    update public.applications set stage = 'hired' where id = ob.application_id;
    select count(*) into v_hired from public.applications where job_id = j.id and stage = 'hired';
    if v_hired >= j.openings and j.status = 'published' then update public.jobs set status = 'closed' where id = j.id; end if;
    perform public.notify_user(ob.company_id, (select user_id from public.employees where id = v_emp), 'employee',
      'Your new role starts ' || public.fmt_date(ob.joining_date), 'Congratulations on your move to ' || j.title || '.', '/app/profile');
    perform public.notify_permission(ob.company_id, 'employees.manage', 'employee', 'Internal move completed',
      trim(cand.first_name || ' ' || cand.last_name) || ' (' || v_code || ') moves to ' || j.title, '/app/employees/' || v_emp);
    return v_emp;
  end if;
  if exists (select 1 from public.employees where company_id = ob.company_id and lower(email) = lower(cand.email)) then
    raise exception 'A former employee with email % exists: reactivate that record instead', cand.email;
  end if;

  insert into public.employees (company_id, employee_code, first_name, last_name, email, phone, city,
    department_id, designation_id, manager_id, employment_type, work_location, joining_date, probation_end_date, status,
    ctc_annual, basic_monthly, hra_monthly, allowances_monthly, candidate_id, application_id)
  values (ob.company_id, '', cand.first_name, cand.last_name, cand.email, cand.phone, cand.current_location,
    coalesce(o.department_id, j.department_id), coalesce(o.designation_id, j.designation_id), o.reporting_manager_id,
    o.employment_type, coalesce(o.work_location, j.location), ob.joining_date,
    case when o.probation_months > 0 then (ob.joining_date + make_interval(months => o.probation_months))::date end,
    case when o.probation_months > 0 then 'probation' else 'active' end,
    o.ctc_annual, o.basic_monthly, o.hra_monthly, o.allowances_monthly, cand.id, ob.application_id)
  returning id, employee_code into v_emp, v_code;

  update public.onboardings set status = 'completed', completed_at = now(), employee_id = v_emp where id = ob.id;
  perform set_config('hrms.stage_note', 'Hired as ' || v_code, true);
  update public.applications set stage = 'hired' where id = ob.application_id;

  insert into public.leave_balances (company_id, employee_id, leave_type_id, year, allocated)
  select ob.company_id, v_emp, lt.id, extract(year from ob.joining_date)::int,
         round(lt.annual_quota * (13 - extract(month from ob.joining_date)) / 12 * 2) / 2
  from public.leave_types lt where lt.company_id = ob.company_id and lt.is_active and lt.is_paid
  on conflict do nothing;

  select count(*) into v_hired from public.applications where job_id = j.id and stage = 'hired';
  if v_hired >= j.openings and j.status = 'published' then
    update public.jobs set status = 'closed' where id = j.id;
  end if;

  -- an internal transfer already has a login: no credentials email for them
  if not exists (select 1 from auth.users u where lower(u.email) = lower(cand.email)) then
    perform public.issue_login_token(v_emp);
  end if;
  perform public.notify_permission(ob.company_id, 'employees.manage', 'employee', 'New employee onboarded',
    trim(cand.first_name || ' ' || cand.last_name) || ' (' || v_code || ') joined', '/app/employees/' || v_emp);
  return v_emp;
end $$;



-- 8. probation: reminders (in run_daily_jobs) and confirm / extend
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
    -- probation ending in 7 days or today (migration 2100)
    for d in select e.id, e.employee_code, e.probation_end_date, e.manager_id, trim(e.first_name || ' ' || coalesce(e.last_name, '')) as emp_name
             from public.employees e where e.company_id = c.id and e.status = 'probation' and e.probation_end_date - v_today in (7, 0) loop
      perform public.notify_permission(c.id, 'employees.manage', 'employee', 'Probation ends ' ||
        case when d.probation_end_date = v_today then 'today' else 'on ' || public.fmt_date(d.probation_end_date) end || ': ' || d.emp_name,
        'Confirm the employment or extend the probation.', '/app/employees/' || d.id);
      perform public.notify_user(c.id, (select m.user_id from public.employees m where m.id = d.manager_id), 'employee',
        'Probation review due: ' || d.emp_name, 'Probation ends on ' || public.fmt_date(d.probation_end_date) || '. Share your feedback with HR.', '/app/employees/' || d.id);
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

create or replace function public.decide_probation(p_employee uuid, p_confirm boolean, p_extend_to date default null, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare e public.employees;
begin
  select * into e from public.employees where id = p_employee for update;
  if e.id is null then raise exception 'Employee not found'; end if;
  perform public.require_permission(e.company_id, 'employees.manage');
  if e.status <> 'probation' then raise exception 'This employee is not on probation'; end if;
  if e.id = public.my_employee_id(e.company_id) then raise exception 'You cannot decide your own probation'; end if;
  if p_confirm then
    update public.employees set status = 'active' where id = e.id;
    perform public.notify_user(e.company_id, e.user_id, 'employee', 'Your employment is confirmed',
      coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Congratulations on completing your probation.'), '/app/profile');
  else
    if p_extend_to is null or p_extend_to <= coalesce(e.probation_end_date, e.joining_date) then
      raise exception 'Choose a new probation end date after the current one';
    end if;
    update public.employees set probation_end_date = p_extend_to where id = e.id;
    perform public.notify_user(e.company_id, e.user_id, 'employee', 'Your probation is extended to ' || public.fmt_date(p_extend_to),
      coalesce(nullif(trim(coalesce(p_note, '')), ''), 'HR will discuss the next steps with you.'), '/app/profile');
  end if;
end $$;
revoke execute on function public.decide_probation(uuid, boolean, date, text) from public, anon;
grant execute on function public.decide_probation(uuid, boolean, date, text) to authenticated;
