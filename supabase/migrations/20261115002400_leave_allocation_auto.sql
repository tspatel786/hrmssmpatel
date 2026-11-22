-- =====================================================================
-- 2400  AUTOMATIC LEAVE BALANCES
-- Before: balances existed only after HR pressed "Allocate" or the employee applied for leave, so employees added by
-- hand saw "No leave balances" and a new year's carry-forward depended on HR remembering to allocate.
-- A. A new employee gets this year's paid leave pro-rated from the joining month (same rule as onboarding).
-- B. The daily job allocates the current year for everyone who has no balance yet, with carry-forward from last year
--    (runs once per company per day, so 1 January is covered automatically). Existing balances are never changed.
-- No table is dropped, no data is deleted, no policy is changed.
-- =====================================================================
create or replace function public.allocate_new_employee_leave() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_year integer := extract(year from (now() at time zone public.company_tz(new.company_id)))::int;
begin
  if new.status in ('active', 'probation', 'notice') and extract(year from new.joining_date)::int <= v_year then
    insert into public.leave_balances (company_id, employee_id, leave_type_id, year, allocated)
    select new.company_id, new.id, lt.id, v_year,
      case when extract(year from new.joining_date)::int = v_year
           then round(lt.annual_quota * (13 - extract(month from new.joining_date)) / 12 * 2) / 2
           else lt.annual_quota end
    from public.leave_types lt where lt.company_id = new.company_id and lt.is_active and lt.is_paid
    on conflict (employee_id, leave_type_id, year) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists trg_allocate_new_employee_leave on public.employees;
create trigger trg_allocate_new_employee_leave after insert on public.employees
  for each row execute function public.allocate_new_employee_leave();

create or replace function public.allocate_year_balances(p_company uuid, p_year integer) returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  insert into public.leave_balances (company_id, employee_id, leave_type_id, year, allocated)
  select p_company, e.id, lt.id, p_year,
    lt.annual_quota + case when lt.carry_forward then coalesce((
      select greatest(0, pb.allocated - pb.used) from public.leave_balances pb
      where pb.employee_id = e.id and pb.leave_type_id = lt.id and pb.year = p_year - 1), 0) else 0 end
  from public.employees e cross join public.leave_types lt
  where e.company_id = p_company and lt.company_id = p_company and lt.is_active and lt.is_paid
    and e.status in ('active', 'probation', 'notice') and extract(year from e.joining_date)::int < p_year
  on conflict (employee_id, leave_type_id, year) do nothing;
  get diagnostics v = row_count;
  return v;
end $$;
revoke execute on function public.allocate_year_balances(uuid, integer) from public, anon, authenticated;

-- B. daily job: unchanged except the yearly allocation line
create or replace function public.run_daily_jobs() returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; v_today date; v_absent integer := 0; v_reminders integer := 0; v_deactivated integer := 0; r record; d record; v_days integer;
begin
  for c in select id from public.companies where status <> 'suspended' loop
    v_today := (now() at time zone public.company_tz(c.id))::date;
    insert into public.daily_job_runs (company_id, run_on) values (c.id, v_today) on conflict do nothing;
    if not found then continue; end if;   -- already ran today for this company

    v_absent := v_absent + public.mark_absentees(c.id, v_today - 7, v_today - 1);
    perform public.allocate_year_balances(c.id, extract(year from v_today)::int);  -- migration 2400

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
