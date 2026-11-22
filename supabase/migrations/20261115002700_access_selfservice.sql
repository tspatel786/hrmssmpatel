-- =====================================================================
-- 2700  ACCESS FOLLOWS EMPLOYMENT STATUS, EMPLOYEE SELF-SERVICE DETAILS
-- 1. Setting an employee to inactive / terminated (termination without a resignation, or by editing the record)
--    left their login open. Their membership now closes with it, and reopens if they are reactivated.
--    Deleting an employee record closes the login linked to it. The last active Company Admin cannot be locked out.
-- 2. Employees can update their own contact details (phone, address, emergency contact, marital status).
--    Bank, PAN, salary, job and dates stay HR-only. HR is notified of every change.
-- (3. the daily failed-email alert is appended below by the build step)
-- No table dropped, no data deleted, no policy loosened.
-- =====================================================================

-- 1. login follows employment status
create or replace function public.sync_member_with_employee() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_closed boolean := false; v_open boolean := false;
begin
  if tg_op = 'DELETE' then
    v_closed := true;
  else
    v_closed := new.status in ('inactive', 'terminated') and old.status not in ('inactive', 'terminated');
    v_open := new.status in ('active', 'probation', 'notice') and old.status in ('inactive', 'terminated');
  end if;
  if v_closed then
    if exists (select 1 from public.company_members m join public.roles r on r.id = m.role_id
               where m.company_id = old.company_id and m.status = 'active' and r.is_admin
                 and (m.employee_id = old.id or (old.user_id is not null and m.user_id = old.user_id)))
       and (select count(*) from public.company_members m join public.roles r on r.id = m.role_id
            where m.company_id = old.company_id and m.status = 'active' and r.is_admin) <= 1 then
      raise exception 'This employee is the only active Company Admin. Make someone else admin first.';
    end if;
    update public.company_members set status = 'inactive'
    where company_id = old.company_id and status = 'active'
      and (employee_id = old.id or (old.user_id is not null and user_id = old.user_id));
  elsif v_open then
    update public.company_members set status = 'active'
    where company_id = new.company_id and status = 'inactive'
      and (employee_id = new.id or (new.user_id is not null and user_id = new.user_id));
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists trg_sync_member_status on public.employees;
create trigger trg_sync_member_status after update of status on public.employees
  for each row execute function public.sync_member_with_employee();
drop trigger if exists trg_sync_member_delete on public.employees;
create trigger trg_sync_member_delete before delete on public.employees
  for each row execute function public.sync_member_with_employee();

-- 2. self-service contact details
create or replace function public.update_my_details(p_company uuid, p_details jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_emp uuid := public.my_employee_id(p_company);
  e public.employees;
  v_changed text[] := '{}';
  v_phone text := nullif(trim(coalesce(p_details ->> 'phone', '')), '');
  v_addr text := nullif(trim(coalesce(p_details ->> 'address', '')), '');
  v_ecn text := nullif(left(trim(coalesce(p_details ->> 'emergency_contact_name', '')), 100), '');
  v_ecp text := nullif(trim(coalesce(p_details ->> 'emergency_contact_phone', '')), '');
  v_marital text := nullif(trim(coalesce(p_details ->> 'marital_status', '')), '');
begin
  if v_emp is null then raise exception 'Your account is not linked to an employee profile'; end if;
  if v_phone is not null and v_phone !~ '^[+0-9 ()-]{7,20}$' then raise exception 'Enter a valid phone number'; end if;
  if v_ecp is not null and v_ecp !~ '^[+0-9 ()-]{7,20}$' then raise exception 'Enter a valid emergency contact phone'; end if;
  if v_marital is not null and v_marital not in ('single', 'married', 'other') then raise exception 'Invalid marital status'; end if;
  if char_length(coalesce(v_addr, '')) > 300 then raise exception 'Address is too long (max 300 characters)'; end if;
  select * into e from public.employees where id = v_emp for update;
  update public.employees set
    phone = v_phone, address = v_addr,
    city = nullif(left(trim(coalesce(p_details ->> 'city', '')), 80), ''),
    state = nullif(left(trim(coalesce(p_details ->> 'state', '')), 80), ''),
    postal_code = nullif(left(trim(coalesce(p_details ->> 'postal_code', '')), 12), ''),
    emergency_contact_name = v_ecn, emergency_contact_phone = v_ecp, marital_status = v_marital
  where id = v_emp;
  if e.phone is distinct from v_phone then v_changed := v_changed || 'phone'::text; end if;
  if e.address is distinct from v_addr then v_changed := v_changed || 'address'::text; end if;
  if e.emergency_contact_name is distinct from v_ecn or e.emergency_contact_phone is distinct from v_ecp then
    v_changed := v_changed || 'emergency contact'::text;
  end if;
  if coalesce(array_length(v_changed, 1), 0) > 0 then
    perform public.notify_permission(p_company, 'employees.manage', 'employee',
      'Details updated by ' || trim(e.first_name || ' ' || coalesce(e.last_name, '')),
      'Changed: ' || array_to_string(v_changed, ', ') || '.', '/app/employees/' || e.id);
  end if;
end $$;
revoke execute on function public.update_my_details(uuid, jsonb) from public, anon;
grant execute on function public.update_my_details(uuid, jsonb) to authenticated;

-- 3. daily job: failed-email alert (everything else unchanged)
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
    -- migration 2500 -------------------------------------------------------------------------------------------
    -- offers past their expiry date become "expired" (was never run: they stayed "sent" forever)
    perform public.expire_offers();  -- same rules as the offer workflow (guarded status change)

    -- missed clock-out yesterday: the employee is asked to file a correction (hours are otherwise unknown)
    for d in select a.attendance_date, e.user_id from public.attendance_records a join public.employees e on e.id = a.employee_id
             where a.company_id = c.id and a.attendance_date = v_today - 1 and a.check_in is not null and a.check_out is null loop
      perform public.notify_user(c.id, d.user_id, 'attendance', 'You did not clock out on ' || public.fmt_date(d.attendance_date),
        'Your working hours for that day are incomplete. Please request an attendance correction with your actual out time.',
        '/app/attendance?tab=corrections');
      v_reminders := v_reminders + 1;
    end loop;

    -- leave requests waiting 2 days: remind the reporting manager (or leave approvers when there is none)
    for d in select lr.id, lr.start_date, trim(e.first_name || ' ' || coalesce(e.last_name, '')) as emp_name, m.user_id as mgr_user
             from public.leave_requests lr join public.employees e on e.id = lr.employee_id
             left join public.employees m on m.id = e.manager_id and m.status in ('active', 'probation', 'notice')
             where lr.company_id = c.id and lr.status = 'pending'
               and (lr.created_at at time zone public.company_tz(c.id))::date = v_today - 2 loop
      if d.mgr_user is not null then
        perform public.notify_user(c.id, d.mgr_user, 'leave', 'Reminder: leave request from ' || d.emp_name,
          'Waiting for your decision for 2 days. Leave starts ' || public.fmt_date(d.start_date) || '.', '/app/leave?tab=approvals');
      else
        perform public.notify_permission(c.id, 'leave.approve', 'leave', 'Reminder: leave request from ' || d.emp_name,
          'Waiting for a decision for 2 days. Leave starts ' || public.fmt_date(d.start_date) || '.', '/app/leave?tab=approvals');
      end if;
      v_reminders := v_reminders + 1;
    end loop;

    -- joining documents still missing 3 and 7 days after the offer was accepted: email the upload link again
    for d in select o.id from public.onboardings o
             where o.company_id = c.id and o.status in ('pending', 'in_progress')
               and (o.created_at at time zone public.company_tz(c.id))::date in (v_today - 3, v_today - 7)
               and exists (select 1 from public.onboarding_documents x where x.onboarding_id = o.id and x.required and x.status in ('pending', 'rejected')) loop
      perform public.enqueue_email(c.id, 'documents_requested', (public.onboarding_doc_vars(d.id)) ->> 'candidate_email',
        (public.onboarding_doc_vars(d.id)) ->> 'candidate_name', public.onboarding_doc_vars(d.id),
        'onboarding:' || d.id || ':documents-reminder:' || v_today, 'onboardings', d.id);
      v_reminders := v_reminders + 1;
    end loop;

    -- set-password link expired without being used: HR can send a new one
    for d in select e.id, trim(e.first_name || ' ' || coalesce(e.last_name, '')) as emp_name, e.employee_code
             from public.employee_activations a join public.employees e on e.id = a.employee_id
             where e.company_id = c.id and e.user_id is null and (a.expires_at at time zone public.company_tz(c.id))::date = v_today - 1 loop
      perform public.notify_permission(c.id, 'employees.manage', 'employee', 'Login link expired: ' || d.emp_name,
        d.employee_code || ' did not set a password within 7 days. Use "Send login email" to send a new link.', '/app/employees/' || d.id);
      v_reminders := v_reminders + 1;
    end loop;

    -- emails that failed for good yesterday (3 attempts): tell the people who manage emails (migration 2700)
    for d in select count(*)::int as n from public.email_logs l
             where l.company_id = c.id and l.status = 'failed' and l.attempts >= 3
               and (l.updated_at at time zone public.company_tz(c.id))::date = v_today - 1 having count(*) > 0 loop
      perform public.notify_permission(c.id, 'emails.manage', 'info', d.n || ' email(s) could not be delivered',
        'Check the address or retry them from the Email Center.', '/app/emails');
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
