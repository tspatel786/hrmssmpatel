-- =====================================================================
-- 2500  TIME-BASED GAPS (daily job additions)
-- 1. Expired offers were never marked "expired" (expire_offers was not scheduled): they stayed "sent" forever.
-- 2. A missed clock-out left the day "present" with unknown hours: the employee is now asked to file a correction.
-- 3. Leave requests could wait forever: the approver is reminded after 2 days.
-- 4. Joiners who did not upload documents got one email only: the link is emailed again after 3 and 7 days.
-- 5. Unused set-password links expired silently: HR is told so they can send a new one.
-- Only run_daily_jobs changes (still once per company per day). No table dropped, no data deleted.
-- =====================================================================
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
