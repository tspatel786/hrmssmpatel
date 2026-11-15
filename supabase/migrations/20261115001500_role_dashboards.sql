-- =====================================================================
-- 1500  ROLE-BASED DASHBOARDS (daily-operations requirement)
--
-- A. dashboard_stats returned every company metric to anyone with dashboard.view: a Recruiter (no payroll.view)
--    received the company's total net payroll, a Payroll Manager the recruitment funnel. Each metric group is now
--    returned only to roles holding the matching permission (null otherwise). Same JSON shape, so older frontends
--    keep working.
-- B. team_dashboard: what a line manager needs every day for their DIRECT REPORTS (employees.manager_id):
--    who is in today, on leave, not marked, and how many leave / attendance-correction requests wait for them.
-- C. Hiring Managers can approve job requisitions (self-approval stays blocked by the requisition guard trigger).
-- D. HR (employees.manage) can give an employee record HRMS access with the built-in Employee role only; every other
--    role, and changing an existing member's role, still needs users.manage (Company Admin).
-- No table is dropped, no data is deleted, no policy is loosened.
-- =====================================================================

-- ---------- A. permission-filtered company dashboard ----------
create or replace function public.dashboard_stats(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone public.company_tz(p_company))::date;
  v_month date := date_trunc('month', v_today)::date;
  p_people boolean; p_recruit boolean; p_offers boolean; p_onboard boolean; p_att boolean; p_leave boolean; p_pay boolean;
begin
  perform public.require_permission(p_company, 'dashboard.view');
  p_people  := public.has_permission(p_company, 'employees.view');
  p_recruit := public.has_permission(p_company, 'candidates.view');
  p_offers  := public.has_permission(p_company, 'offers.view');
  p_onboard := public.has_permission(p_company, 'onboarding.view');
  p_att     := public.has_permission(p_company, 'attendance.view');
  p_leave   := public.has_permission(p_company, 'leave.view') or public.has_permission(p_company, 'leave.approve');
  p_pay     := public.has_permission(p_company, 'payroll.view');
  return jsonb_build_object(
    'sections', jsonb_build_object('people', p_people, 'recruitment', p_recruit, 'offers', p_offers, 'onboarding', p_onboard,
                                   'attendance', p_att, 'leave', p_leave, 'payroll', p_pay),
    'headcount', case when p_people then (select count(*) from public.employees where company_id = p_company and status in ('active','probation','notice')) end,
    'new_hires_month', case when p_people then (select count(*) from public.employees where company_id = p_company and joining_date >= v_month) end,
    'exits_month', case when p_people then (select count(*) from public.employees where company_id = p_company and exit_date >= v_month) end,
    'open_jobs', case when p_recruit then (select count(*) from public.jobs where company_id = p_company and status = 'published') end,
    'open_positions', case when p_recruit then (select coalesce(sum(openings), 0) from public.jobs where company_id = p_company and status = 'published') end,
    'applications_30d', case when p_recruit then (select count(*) from public.applications where company_id = p_company and applied_at > now() - interval '30 days') end,
    'applications_prev_30d', case when p_recruit then (select count(*) from public.applications where company_id = p_company
                               and applied_at between now() - interval '60 days' and now() - interval '30 days') end,
    'active_candidates', case when p_recruit then (select count(*) from public.applications where company_id = p_company
                           and stage in ('applied','screening','shortlisted','interview','selected','offered','on_hold')) end,
    'interviews_upcoming', case when p_recruit then (select count(*) from public.interviews where company_id = p_company and status = 'scheduled'
                             and scheduled_at between now() and now() + interval '7 days') end,
    'offers_pending', case when p_offers then (select count(*) from public.offers where company_id = p_company and status in ('sent','pending_approval','approved')) end,
    'offers_accepted_90d', case when p_offers then (select count(*) from public.offers where company_id = p_company and status = 'accepted' and responded_at > now() - interval '90 days') end,
    'offers_declined_90d', case when p_offers then (select count(*) from public.offers where company_id = p_company and status = 'declined' and responded_at > now() - interval '90 days') end,
    'onboarding_active', case when p_onboard then (select count(*) from public.onboardings where company_id = p_company and status in ('pending','in_progress')) end,
    'pending_leave', case when p_leave then (select count(*) from public.leave_requests where company_id = p_company and status = 'pending') end,
    'present_today', case when p_att then (select count(*) from public.attendance_records where company_id = p_company and attendance_date = v_today and status in ('present','half_day') and check_in is not null) end,
    'on_leave_today', case when p_att then (select count(*) from public.attendance_records where company_id = p_company and attendance_date = v_today and status in ('on_leave')) end,
    'last_payroll', case when p_pay then (select jsonb_build_object('period', to_char(make_date(period_year, period_month, 1), 'Mon YYYY'), 'net', total_net, 'status', status)
                     from public.payroll_runs where company_id = p_company order by period_year desc, period_month desc limit 1) end,
    'avg_time_to_hire_days', case when p_recruit then (select round(avg(extract(epoch from (h.created_at - a.applied_at)) / 86400)::numeric, 1)
                               from public.applications a join public.application_stage_history h on h.application_id = a.id and h.to_stage = 'hired'
                               where a.company_id = p_company and h.created_at > now() - interval '180 days') end,
    'pipeline', case when p_recruit then (select coalesce(jsonb_agg(jsonb_build_object('stage', s.stage, 'count', coalesce(x.n, 0)) order by s.ord), '[]')
                 from (values ('applied',1),('screening',2),('shortlisted',3),('interview',4),('selected',5),('offered',6),('hired',7),('rejected',8),('on_hold',9)) s(stage, ord)
                 left join (select stage, count(*) n from public.applications where company_id = p_company group by stage) x on x.stage = s.stage) end,
    'applications_trend', case when p_recruit then (select coalesce(jsonb_agg(jsonb_build_object('week', to_char(w, 'DD Mon'), 'count', (
                              select count(*) from public.applications a where a.company_id = p_company
                              and a.applied_at >= w and a.applied_at < w + interval '7 days')) order by w), '[]')
                           from generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') w) end,
    'headcount_by_department', case when p_people then (select coalesce(jsonb_agg(jsonb_build_object('department', coalesce(d.name, 'Unassigned'), 'count', x.n) order by x.n desc), '[]')
                                from (select department_id, count(*) n from public.employees
                                      where company_id = p_company and status in ('active','probation','notice') group by department_id) x
                                left join public.departments d on d.id = x.department_id) end,
    'sources', case when p_recruit then (select coalesce(jsonb_agg(jsonb_build_object('source', c.source, 'count', count)), '[]') from (
                  select c.source, count(*) from public.applications a join public.candidates c on c.id = a.candidate_id
                  where a.company_id = p_company group by c.source) c) end,
    'attendance_trend', case when p_att then (select coalesce(jsonb_agg(jsonb_build_object('date', to_char(d, 'DD Mon'),
                           'present', (select count(*) from public.attendance_records a where a.company_id = p_company and a.attendance_date = d::date and a.status in ('present','half_day')),
                           'leave', (select count(*) from public.attendance_records a where a.company_id = p_company and a.attendance_date = d::date and a.status = 'on_leave'),
                           'absent', (select count(*) from public.attendance_records a where a.company_id = p_company and a.attendance_date = d::date and a.status = 'absent')) order by d), '[]')
                         from generate_series(v_today - 13, v_today, interval '1 day') d) end
  );
end $$;

-- ---------- B. line-manager dashboard (direct reports only) ----------
create or replace function public.team_dashboard(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me uuid; v_today date := (now() at time zone public.company_tz(p_company))::date;
begin
  if not public.is_member(p_company) then raise exception 'Not a member of this company' using errcode = '42501'; end if;
  v_me := public.my_employee_id(p_company);
  if v_me is null then return jsonb_build_object('team_size', 0, 'members', '[]'::jsonb); end if;
  return (
    with team as (
      select e.id, trim(e.first_name || ' ' || e.last_name) as name, e.employee_code
      from public.employees e
      where e.company_id = p_company and e.manager_id = v_me and e.status in ('active','probation','notice')
    ), today as (
      select t.*, a.status as att_status, a.check_in, a.check_out, coalesce(a.is_late, false) as is_late
      from team t left join public.attendance_records a on a.employee_id = t.id and a.attendance_date = v_today
    )
    select jsonb_build_object(
      'team_size', (select count(*) from team),
      'present_today', (select count(*) from today where att_status in ('present','half_day') and check_in is not null),
      'on_leave_today', (select count(*) from today where att_status = 'on_leave'),
      'not_marked_today', (select count(*) from today where att_status is null),
      'late_today', (select count(*) from today where is_late),
      'pending_leave', (select count(*) from public.leave_requests r join team t on t.id = r.employee_id where r.status = 'pending'),
      'pending_corrections', (select count(*) from public.attendance_corrections c join team t on t.id = c.employee_id where c.status = 'pending'),
      'members', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', employee_code, 'status', att_status,
                    'check_in', check_in, 'check_out', check_out, 'is_late', is_late) order by name), '[]'::jsonb) from today)
    )
  );
end $$;
revoke all on function public.team_dashboard(uuid) from anon;
grant execute on function public.team_dashboard(uuid) to authenticated;

-- ---------- C. Hiring Managers approve requisitions ----------
insert into public.role_permissions (role_id, permission)
select id, 'requisitions.approve' from public.roles where name = 'Hiring Manager' and is_system
on conflict do nothing;

-- new companies: the provisioning function inserts the Hiring Manager role with a fixed permission list; add the grant
-- as soon as that system role row exists
create or replace function public.grant_hiring_manager_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_system and new.name = 'Hiring Manager' then
    insert into public.role_permissions (role_id, permission) values (new.id, 'requisitions.approve') on conflict do nothing;
  end if;
  return new;
end $$;
create trigger trg_roles_hiring_manager_defaults after insert on public.roles
  for each row execute function public.grant_hiring_manager_defaults();

-- ---------- D. HR can give employees HRMS access (Employee role only) ----------
-- Before: only users.manage (Company Admin) could invite anyone, so HR Managers could not onboard staff into the HRMS.
-- Now employees.manage holders may invite, but ONLY: the built-in Employee role, for an existing employee record of this
-- company whose work email matches, which has no login yet, and never for a user who is already a member (so HR can
-- neither grant privileged roles nor change anyone's existing role). users.manage keeps the full behaviour.
create or replace function public.invite_member(p_company uuid, p_email text, p_role uuid, p_employee uuid default null, p_base_url text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_user uuid;
  v_inv uuid;
  v_role_name text;
  v_role_system boolean;
  v_full boolean := public.has_permission(p_company, 'users.manage');
  v_emp public.employees;
begin
  if not v_full and not public.has_permission(p_company, 'employees.manage') then
    raise exception 'You do not have permission to invite users' using errcode = '42501';
  end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  select name, is_system into v_role_name, v_role_system from public.roles where id = p_role and company_id = p_company;
  if v_role_name is null then raise exception 'Invalid role'; end if;
  if p_employee is not null and not exists (select 1 from public.employees where id = p_employee and company_id = p_company) then
    raise exception 'Invalid employee';
  end if;
  if not v_full then
    if not (v_role_system and v_role_name = 'Employee') then
      raise exception 'Only a Company Admin can grant roles other than Employee' using errcode = '42501';
    end if;
    if p_employee is null then raise exception 'Choose the employee record to link' using errcode = '42501'; end if;
    select * into v_emp from public.employees where id = p_employee;
    if v_emp.user_id is not null then raise exception 'This employee already has HRMS access'; end if;
    if lower(coalesce(v_emp.email, '')) <> v_email then
      raise exception 'The invitation email must match the employee''s work email' using errcode = '42501';
    end if;
  end if;

  select id into v_user from public.profiles where lower(email) = v_email;
  if v_user is not null then
    if exists (select 1 from public.company_members where company_id = p_company and user_id = v_user) then
      if not v_full then
        raise exception 'This user is already a member; ask a Company Admin to change their access' using errcode = '42501';
      end if;
      update public.company_members set role_id = p_role, status = 'active', employee_id = coalesce(p_employee, employee_id)
        where company_id = p_company and user_id = v_user;
      return jsonb_build_object('status', 'updated');
    end if;
    insert into public.company_members (company_id, user_id, role_id, employee_id, invited_by)
    values (p_company, v_user, p_role, p_employee, auth.uid());
    if p_employee is not null then update public.employees set user_id = v_user where id = p_employee; end if;
    perform public.notify_user(p_company, v_user, 'info', 'You were added to a company',
      'You now have access as ' || v_role_name, '/app');
    return jsonb_build_object('status', 'added');
  end if;

  update public.company_invitations set status = 'revoked'
    where company_id = p_company and lower(email) = v_email and status = 'pending';
  insert into public.company_invitations (company_id, email, role_id, employee_id)
  values (p_company, v_email, p_role, p_employee) returning id into v_inv;
  perform public.enqueue_email(p_company, 'user_invitation', v_email, null,
    jsonb_build_object('role_name', v_role_name,
      'invite_link', coalesce(nullif(p_base_url, ''), '') || '/signup?email=' || v_email),
    'invite:' || v_inv::text, 'company_invitations', v_inv);
  return jsonb_build_object('status', 'invited', 'invitation_id', v_inv);
end $$;
