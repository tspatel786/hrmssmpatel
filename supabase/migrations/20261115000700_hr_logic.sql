-- =====================================================================
-- 0700  HR LOGIC: attendance, leave, payroll, dashboards, reports,
--       notifications, email worker API
-- =====================================================================

create or replace function public.working_dates(p_company uuid, p_from date, p_to date)
returns setof date language sql stable security definer set search_path = public as $$
  select d::date from generate_series(p_from, p_to, interval '1 day') d
  where extract(isodow from d)::smallint in (select unnest(working_days) from public.companies where id = p_company)
    and not exists (select 1 from public.holidays h where h.company_id = p_company and h.holiday_date = d::date and not h.is_optional)
$$;

create or replace function public.count_working_days(p_company uuid, p_from date, p_to date) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.working_dates(p_company, p_from, p_to)
$$;

-- ======================= ATTENDANCE =========================
create or replace function public.clock_in(p_company uuid, p_notes text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); v_today date; v_id uuid; r public.attendance_records;
begin
  if v_emp is null then raise exception 'Your account is not linked to an employee profile'; end if;
  v_today := (now() at time zone public.company_tz(p_company))::date;
  select * into r from public.attendance_records where employee_id = v_emp and attendance_date = v_today;
  if r.check_in is not null then raise exception 'You have already clocked in today'; end if;
  if r.id is not null then
    update public.attendance_records set check_in = now(), status = 'present', source = 'self', notes = coalesce(p_notes, notes)
      where id = r.id returning id into v_id;
  else
    insert into public.attendance_records (company_id, employee_id, attendance_date, check_in, status, source, notes)
    values (p_company, v_emp, v_today, now(), 'present', 'self', p_notes) returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.clock_out(p_company uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); v_today date; r public.attendance_records; v_status text;
begin
  if v_emp is null then raise exception 'Your account is not linked to an employee profile'; end if;
  v_today := (now() at time zone public.company_tz(p_company))::date;
  select * into r from public.attendance_records where employee_id = v_emp and attendance_date = v_today;
  if r.check_in is null then raise exception 'You have not clocked in today'; end if;
  if r.check_out is not null then raise exception 'You have already clocked out today'; end if;
  v_status := case when now() - r.check_in < interval '4 hours' then 'half_day' else 'present' end;
  update public.attendance_records set check_out = now(), status = v_status where id = r.id;
  return r.id;
end $$;

create or replace function public.upsert_attendance(p_company uuid, p_employee uuid, p_date date, p_status text,
  p_check_in timestamptz default null, p_check_out timestamptz default null, p_notes text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.require_permission(p_company, 'attendance.manage');
  if not exists (select 1 from public.employees where id = p_employee and company_id = p_company) then raise exception 'Invalid employee'; end if;
  if p_date > (now() at time zone public.company_tz(p_company))::date then raise exception 'Cannot mark attendance for a future date'; end if;
  if p_check_in is not null and p_check_out is not null and p_check_out < p_check_in then raise exception 'Check-out must be after check-in'; end if;
  insert into public.attendance_records (company_id, employee_id, attendance_date, check_in, check_out, status, source, notes)
  values (p_company, p_employee, p_date, p_check_in, p_check_out, p_status, 'manual', p_notes)
  on conflict (employee_id, attendance_date) do update set check_in = excluded.check_in, check_out = excluded.check_out,
    status = excluded.status, source = 'manual', notes = excluded.notes
  returning id into v_id;
  return v_id;
end $$;

-- ======================= LEAVE =========================
create or replace function public.ensure_leave_balance(p_company uuid, p_employee uuid, p_type uuid, p_year integer)
returns public.leave_balances language plpgsql security definer set search_path = public as $$
declare b public.leave_balances;
begin
  insert into public.leave_balances (company_id, employee_id, leave_type_id, year, allocated)
  select p_company, p_employee, p_type, p_year, annual_quota from public.leave_types where id = p_type
  on conflict (employee_id, leave_type_id, year) do nothing;
  select * into b from public.leave_balances where employee_id = p_employee and leave_type_id = p_type and year = p_year;
  return b;
end $$;
revoke execute on function public.ensure_leave_balance(uuid, uuid, uuid, integer) from public, anon, authenticated;

create or replace function public.apply_leave(p_company uuid, p_employee uuid, p_type uuid, p_start date, p_end date,
  p_half_day boolean, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_emp uuid := coalesce(p_employee, public.my_employee_id(p_company));
  lt public.leave_types; e public.employees; b public.leave_balances;
  v_days numeric; v_pending numeric; v_id uuid; v_mgr_user uuid;
begin
  if v_emp is null then raise exception 'Your account is not linked to an employee profile'; end if;
  if v_emp is distinct from public.my_employee_id(p_company) then
    perform public.require_permission(p_company, 'leave.manage');
  end if;
  select * into e from public.employees where id = v_emp and company_id = p_company;
  if e.id is null then raise exception 'Invalid employee'; end if;
  select * into lt from public.leave_types where id = p_type and company_id = p_company and is_active;
  if lt.id is null then raise exception 'Invalid leave type'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'End date must be on or after start date'; end if;
  if extract(year from p_start) <> extract(year from p_end) then raise exception 'Leave cannot span two calendar years; split the request'; end if;
  if p_end - p_start > 60 then raise exception 'Leave requests are limited to 60 days'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'Please provide a reason'; end if;
  if p_half_day and p_start <> p_end then raise exception 'Half-day leave must be a single day'; end if;

  v_days := public.count_working_days(p_company, p_start, p_end);
  if v_days = 0 then raise exception 'The selected dates are weekends or holidays'; end if;
  if p_half_day then v_days := 0.5; end if;

  if exists (select 1 from public.leave_requests where employee_id = v_emp and status in ('pending','approved')
             and daterange(start_date, end_date, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'You already have a leave request overlapping these dates';
  end if;

  if lt.is_paid then
    b := public.ensure_leave_balance(p_company, v_emp, lt.id, extract(year from p_start)::int);
    select coalesce(sum(days), 0) into v_pending from public.leave_requests
      where employee_id = v_emp and leave_type_id = lt.id and status = 'pending' and extract(year from start_date) = b.year;
    if b.allocated - b.used - v_pending < v_days then
      raise exception 'Insufficient % balance: % day(s) available, % requested', lt.name, b.allocated - b.used - v_pending, v_days;
    end if;
  end if;

  insert into public.leave_requests (company_id, employee_id, leave_type_id, start_date, end_date, half_day, days, reason)
  values (p_company, v_emp, lt.id, p_start, p_end, coalesce(p_half_day, false), v_days, trim(p_reason)) returning id into v_id;

  select m.user_id into v_mgr_user from public.employees m where m.id = e.manager_id;
  perform public.notify_user(p_company, v_mgr_user, 'leave', 'Leave request',
    trim(e.first_name || ' ' || e.last_name) || ' requested ' || v_days || ' day(s) of ' || lt.name, '/app/leave?tab=approvals');
  perform public.notify_permission(p_company, 'leave.approve', 'leave', 'Leave request',
    trim(e.first_name || ' ' || e.last_name) || ' requested ' || v_days || ' day(s) of ' || lt.name, '/app/leave?tab=approvals');
  return v_id;
end $$;

create or replace function public.can_approve_leave(p_request uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.leave_requests r join public.employees e on e.id = r.employee_id
    where r.id = p_request
      and r.employee_id is distinct from public.my_employee_id(r.company_id)
      and (public.has_permission(r.company_id, 'leave.approve')
           or e.manager_id = public.my_employee_id(r.company_id))
  )
$$;

create or replace function public.decide_leave(p_request uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.leave_requests; e public.employees; lt public.leave_types; b public.leave_balances; d date;
begin
  select * into r from public.leave_requests where id = p_request for update;
  if r.id is null then raise exception 'Leave request not found'; end if;
  if not public.can_approve_leave(r.id) then raise exception 'You are not allowed to decide this leave request' using errcode = '42501'; end if;
  if r.status <> 'pending' then raise exception 'This request has already been %', r.status; end if;
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

create or replace function public.cancel_leave(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.leave_requests; lt public.leave_types;
begin
  select * into r from public.leave_requests where id = p_request for update;
  if r.id is null then raise exception 'Leave request not found'; end if;
  if r.employee_id is distinct from public.my_employee_id(r.company_id) and not public.has_permission(r.company_id, 'leave.manage') then
    raise exception 'You cannot cancel this request' using errcode = '42501';
  end if;
  if r.status not in ('pending','approved') then raise exception 'Only pending or approved requests can be cancelled'; end if;
  if r.status = 'approved' and r.start_date <= current_date and not public.has_permission(r.company_id, 'leave.manage') then
    raise exception 'Leave that has already started can only be cancelled by HR';
  end if;
  select * into lt from public.leave_types where id = r.leave_type_id;
  if r.status = 'approved' then
    if lt.is_paid then
      update public.leave_balances set used = greatest(0, used - r.days)
       where employee_id = r.employee_id and leave_type_id = r.leave_type_id and year = extract(year from r.start_date)::int;
    end if;
    delete from public.attendance_records where employee_id = r.employee_id and source = 'system'
      and attendance_date between r.start_date and r.end_date and status in ('on_leave','half_day') and check_in is null;
  end if;
  update public.leave_requests set status = 'cancelled' where id = r.id;
end $$;

create or replace function public.allocate_leave_balances(p_company uuid, p_year integer) returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  perform public.require_permission(p_company, 'leave.manage');
  insert into public.leave_balances (company_id, employee_id, leave_type_id, year, allocated)
  select p_company, e.id, lt.id, p_year,
    lt.annual_quota + case when lt.carry_forward then coalesce((
      select greatest(0, pb.allocated - pb.used) from public.leave_balances pb
      where pb.employee_id = e.id and pb.leave_type_id = lt.id and pb.year = p_year - 1), 0) else 0 end
  from public.employees e cross join public.leave_types lt
  where e.company_id = p_company and lt.company_id = p_company and lt.is_active and lt.is_paid
    and e.status not in ('inactive','terminated')
  on conflict (employee_id, leave_type_id, year) do nothing;
  get diagnostics v = row_count;
  return v;
end $$;

-- ======================= PAYROLL =========================
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
             and status in ('active','probation','notice') and (basic_monthly + hra_monthly + allowances_monthly) > 0 loop
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

create or replace function public.finalize_payroll(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.payroll_runs; c public.companies; s record; v_period text;
begin
  select * into r from public.payroll_runs where id = p_run for update;
  if r.id is null then raise exception 'Payroll run not found'; end if;
  perform public.require_permission(r.company_id, 'payroll.manage');
  if r.status <> 'draft' then raise exception 'Payroll run is already %', r.status; end if;
  if r.employee_count = 0 then raise exception 'Payroll run has no payslips'; end if;
  select * into c from public.companies where id = r.company_id;
  update public.payroll_runs set status = 'processed', processed_at = now() where id = r.id;
  v_period := to_char(make_date(r.period_year, r.period_month, 1), 'FMMonth YYYY');
  for s in select p.*, e.email, e.user_id, trim(e.first_name || ' ' || e.last_name) as name
           from public.payslips p join public.employees e on e.id = p.employee_id where p.payroll_run_id = r.id loop
    perform public.notify_user(r.company_id, s.user_id, 'payroll', 'Payslip available', 'Your payslip for ' || v_period || ' is ready', '/app/payroll/my-payslips');
    perform public.enqueue_email(r.company_id, 'payslip_available', s.email, s.name,
      jsonb_build_object('employee_name', s.name, 'period', v_period, 'net_pay', public.fmt_money(s.net_pay, c.currency)),
      'payslip:' || s.id, 'payslips', s.id);
  end loop;
end $$;

create or replace function public.mark_payroll_paid(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.payroll_runs;
begin
  select * into r from public.payroll_runs where id = p_run;
  if r.id is null then raise exception 'Payroll run not found'; end if;
  perform public.require_permission(r.company_id, 'payroll.manage');
  if r.status <> 'processed' then raise exception 'Only processed payroll can be marked as paid'; end if;
  update public.payroll_runs set status = 'paid', paid_at = now() where id = r.id;
end $$;

-- ======================= NOTIFICATIONS =========================
create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  update public.notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics v = row_count;
  return v;
end $$;

-- ======================= DASHBOARDS =========================
create or replace function public.dashboard_stats(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone public.company_tz(p_company))::date; v_month date := date_trunc('month', v_today)::date;
begin
  perform public.require_permission(p_company, 'dashboard.view');
  return jsonb_build_object(
    'headcount', (select count(*) from public.employees where company_id = p_company and status in ('active','probation','notice')),
    'new_hires_month', (select count(*) from public.employees where company_id = p_company and joining_date >= v_month),
    'exits_month', (select count(*) from public.employees where company_id = p_company and exit_date >= v_month),
    'open_jobs', (select count(*) from public.jobs where company_id = p_company and status = 'published'),
    'open_positions', (select coalesce(sum(openings), 0) from public.jobs where company_id = p_company and status = 'published'),
    'applications_30d', (select count(*) from public.applications where company_id = p_company and applied_at > now() - interval '30 days'),
    'applications_prev_30d', (select count(*) from public.applications where company_id = p_company
                               and applied_at between now() - interval '60 days' and now() - interval '30 days'),
    'active_candidates', (select count(*) from public.applications where company_id = p_company
                           and stage in ('applied','screening','shortlisted','interview','selected','offered','on_hold')),
    'interviews_upcoming', (select count(*) from public.interviews where company_id = p_company and status = 'scheduled'
                             and scheduled_at between now() and now() + interval '7 days'),
    'offers_pending', (select count(*) from public.offers where company_id = p_company and status in ('sent','pending_approval','approved')),
    'offers_accepted_90d', (select count(*) from public.offers where company_id = p_company and status = 'accepted' and responded_at > now() - interval '90 days'),
    'offers_declined_90d', (select count(*) from public.offers where company_id = p_company and status = 'declined' and responded_at > now() - interval '90 days'),
    'onboarding_active', (select count(*) from public.onboardings where company_id = p_company and status in ('pending','in_progress')),
    'pending_leave', (select count(*) from public.leave_requests where company_id = p_company and status = 'pending'),
    'present_today', (select count(*) from public.attendance_records where company_id = p_company and attendance_date = v_today and status in ('present','half_day') and check_in is not null),
    'on_leave_today', (select count(*) from public.attendance_records where company_id = p_company and attendance_date = v_today and status in ('on_leave')),
    'last_payroll', (select jsonb_build_object('period', to_char(make_date(period_year, period_month, 1), 'Mon YYYY'), 'net', total_net, 'status', status)
                     from public.payroll_runs where company_id = p_company order by period_year desc, period_month desc limit 1),
    'avg_time_to_hire_days', (select round(avg(extract(epoch from (h.created_at - a.applied_at)) / 86400)::numeric, 1)
                               from public.applications a join public.application_stage_history h on h.application_id = a.id and h.to_stage = 'hired'
                               where a.company_id = p_company and h.created_at > now() - interval '180 days'),
    'pipeline', (select coalesce(jsonb_agg(jsonb_build_object('stage', s.stage, 'count', coalesce(x.n, 0)) order by s.ord), '[]')
                 from (values ('applied',1),('screening',2),('shortlisted',3),('interview',4),('selected',5),('offered',6),('hired',7),('rejected',8),('on_hold',9)) s(stage, ord)
                 left join (select stage, count(*) n from public.applications where company_id = p_company group by stage) x on x.stage = s.stage),
    'applications_trend', (select coalesce(jsonb_agg(jsonb_build_object('week', to_char(w, 'DD Mon'), 'count', (
                              select count(*) from public.applications a where a.company_id = p_company
                              and a.applied_at >= w and a.applied_at < w + interval '7 days')) order by w), '[]')
                           from generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') w),
    'headcount_by_department', (select coalesce(jsonb_agg(jsonb_build_object('department', coalesce(d.name, 'Unassigned'), 'count', x.n) order by x.n desc), '[]')
                                from (select department_id, count(*) n from public.employees
                                      where company_id = p_company and status in ('active','probation','notice') group by department_id) x
                                left join public.departments d on d.id = x.department_id),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('source', c.source, 'count', count)), '[]') from (
                  select c.source, count(*) from public.applications a join public.candidates c on c.id = a.candidate_id
                  where a.company_id = p_company group by c.source) c),
    'attendance_trend', (select coalesce(jsonb_agg(jsonb_build_object('date', to_char(d, 'DD Mon'),
                           'present', (select count(*) from public.attendance_records a where a.company_id = p_company and a.attendance_date = d::date and a.status in ('present','half_day')),
                           'leave', (select count(*) from public.attendance_records a where a.company_id = p_company and a.attendance_date = d::date and a.status = 'on_leave'),
                           'absent', (select count(*) from public.attendance_records a where a.company_id = p_company and a.attendance_date = d::date and a.status = 'absent')) order by d), '[]')
                         from generate_series(v_today - 13, v_today, interval '1 day') d)
  );
end $$;

-- Self-service dashboard available to every member
create or replace function public.my_dashboard(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); v_today date := (now() at time zone public.company_tz(p_company))::date;
begin
  if not public.is_member(p_company) then raise exception 'Not a member of this company' using errcode = '42501'; end if;
  return jsonb_build_object(
    'employee', (select jsonb_build_object('id', e.id, 'name', trim(e.first_name || ' ' || e.last_name), 'code', e.employee_code,
                   'designation', g.title, 'department', d.name, 'joining_date', e.joining_date)
                 from public.employees e left join public.designations g on g.id = e.designation_id
                 left join public.departments d on d.id = e.department_id where e.id = v_emp),
    'today', (select jsonb_build_object('check_in', check_in, 'check_out', check_out, 'status', status)
              from public.attendance_records where employee_id = v_emp and attendance_date = v_today),
    'leave_balances', (select coalesce(jsonb_agg(jsonb_build_object('type', lt.name, 'color', lt.color, 'allocated', b.allocated, 'used', b.used)), '[]')
                       from public.leave_balances b join public.leave_types lt on lt.id = b.leave_type_id
                       where b.employee_id = v_emp and b.year = extract(year from v_today)::int),
    'pending_leave', (select count(*) from public.leave_requests where employee_id = v_emp and status = 'pending'),
    'month_present', (select count(*) from public.attendance_records where employee_id = v_emp and status in ('present','half_day')
                       and attendance_date >= date_trunc('month', v_today)),
    'holidays', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'date', holiday_date) order by holiday_date), '[]')
                 from (select * from public.holidays where company_id = p_company and holiday_date >= v_today order by holiday_date limit 5) h),
    'my_interviews', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'at', i.scheduled_at, 'round', i.round_name,
                        'candidate', trim(c.first_name || ' ' || c.last_name), 'job', j.title,
                        'feedback_submitted', exists (select 1 from public.interview_feedback f where f.interview_id = i.id and f.interviewer_id = auth.uid())) order by i.scheduled_at), '[]')
                      from public.interviews i join public.interview_panelists p on p.interview_id = i.id and p.user_id = auth.uid()
                      join public.applications a on a.id = i.application_id join public.candidates c on c.id = a.candidate_id
                      join public.jobs j on j.id = a.job_id
                      where i.company_id = p_company and i.status in ('scheduled','completed') and i.scheduled_at > now() - interval '14 days'),
    'team_pending_leave', (select count(*) from public.leave_requests r join public.employees e on e.id = r.employee_id
                           where r.company_id = p_company and r.status = 'pending' and e.manager_id = v_emp)
  );
end $$;

-- ======================= REPORTS =========================
create or replace function public.report_headcount(p_company uuid)
returns table (department text, active bigint, probation bigint, notice bigint, inactive bigint, total bigint, monthly_cost numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_permission(p_company, 'reports.view');
  return query
  select coalesce(d.name, 'Unassigned'),
    count(*) filter (where e.status = 'active'), count(*) filter (where e.status = 'probation'),
    count(*) filter (where e.status = 'notice'), count(*) filter (where e.status in ('inactive','terminated')), count(*),
    coalesce(sum(e.basic_monthly + e.hra_monthly + e.allowances_monthly) filter (where e.status in ('active','probation','notice')), 0)
  from public.employees e left join public.departments d on d.id = e.department_id
  where e.company_id = p_company group by d.name order by 1;
end $$;

create or replace function public.report_attendance(p_company uuid, p_from date, p_to date)
returns table (employee_code text, employee_name text, department text, present bigint, half_day bigint, absent bigint,
  on_leave bigint, total_hours numeric, avg_hours numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_permission(p_company, 'reports.view');
  if p_to < p_from or p_to - p_from > 366 then raise exception 'Choose a date range of up to one year'; end if;
  return query
  select e.employee_code, trim(e.first_name || ' ' || e.last_name), d.name,
    count(a.id) filter (where a.status = 'present'), count(a.id) filter (where a.status = 'half_day'),
    count(a.id) filter (where a.status = 'absent'), count(a.id) filter (where a.status = 'on_leave'),
    round(coalesce(sum(a.work_minutes), 0) / 60.0, 1),
    round(coalesce(avg(a.work_minutes) filter (where a.work_minutes > 0), 0) / 60.0, 1)
  from public.employees e
  left join public.departments d on d.id = e.department_id
  left join public.attendance_records a on a.employee_id = e.id and a.attendance_date between p_from and p_to
  where e.company_id = p_company and e.status not in ('inactive','terminated')
  group by e.id, d.name order by e.employee_code;
end $$;

create or replace function public.report_leave(p_company uuid, p_year integer)
returns table (employee_code text, employee_name text, leave_type text, allocated numeric, used numeric, pending numeric, available numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_permission(p_company, 'reports.view');
  return query
  select e.employee_code, trim(e.first_name || ' ' || e.last_name), lt.name, b.allocated, b.used,
    coalesce((select sum(r.days) from public.leave_requests r where r.employee_id = e.id and r.leave_type_id = lt.id
              and r.status = 'pending' and extract(year from r.start_date) = p_year), 0),
    b.allocated - b.used
  from public.leave_balances b join public.employees e on e.id = b.employee_id join public.leave_types lt on lt.id = b.leave_type_id
  where b.company_id = p_company and b.year = p_year order by e.employee_code, lt.name;
end $$;

create or replace function public.report_recruitment(p_company uuid, p_from date, p_to date)
returns table (job_title text, department text, status text, applications bigint, shortlisted bigint, interviewed bigint,
  offered bigint, hired bigint, rejected bigint, conversion_pct numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_permission(p_company, 'reports.view');
  return query
  select j.title, d.name, j.status, count(a.id),
    count(a.id) filter (where exists (select 1 from public.application_stage_history h where h.application_id = a.id and h.to_stage = 'shortlisted')),
    count(a.id) filter (where exists (select 1 from public.interviews i where i.application_id = a.id)),
    count(a.id) filter (where exists (select 1 from public.offers o where o.application_id = a.id and o.status in ('sent','accepted','declined','expired'))),
    count(a.id) filter (where a.stage = 'hired'), count(a.id) filter (where a.stage = 'rejected'),
    case when count(a.id) > 0 then round(100.0 * count(a.id) filter (where a.stage = 'hired') / count(a.id), 1) else 0 end
  from public.jobs j
  left join public.departments d on d.id = j.department_id
  left join public.applications a on a.job_id = j.id and a.applied_at::date between p_from and p_to
  where j.company_id = p_company
  group by j.id, d.name order by count(a.id) desc, j.title;
end $$;

-- ======================= EMAIL WORKER API =========================
-- Used by the server-side email worker (Supabase Edge Function with service role).
create or replace function public.claim_email_batch(p_limit integer default 20) returns setof public.email_logs
language sql security definer set search_path = public as $$
  update public.email_logs set status = 'sending', attempts = attempts + 1
  where id in (select id from public.email_logs
               where status = 'queued' or (status = 'failed' and attempts < 3 and updated_at < now() - interval '5 minutes')
               order by created_at limit p_limit for update skip locked)
  returning *
$$;

create or replace function public.complete_email(p_id uuid, p_success boolean, p_provider text, p_message_id text, p_error text)
returns void language sql security definer set search_path = public as $$
  update public.email_logs set status = case when p_success then 'sent' else 'failed' end,
    provider = p_provider, provider_message_id = p_message_id, last_error = case when p_success then null else left(p_error, 2000) end,
    sent_at = case when p_success then now() end
  where id = p_id
$$;
revoke execute on function public.claim_email_batch(integer) from public, anon, authenticated;
revoke execute on function public.complete_email(uuid, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_email_batch(integer) to service_role;
grant execute on function public.complete_email(uuid, boolean, text, text, text) to service_role;

create or replace function public.retry_email(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l public.email_logs;
begin
  select * into l from public.email_logs where id = p_id;
  if l.id is null then raise exception 'Email not found'; end if;
  perform public.require_permission(l.company_id, 'emails.manage');
  if l.status not in ('failed','skipped') then raise exception 'Only failed or skipped emails can be retried'; end if;
  if l.status = 'skipped' and l.body_html = '' then raise exception 'This email has no rendered content (template missing)'; end if;
  update public.email_logs set status = 'queued', attempts = 0, last_error = null where id = p_id;
end $$;

create or replace function public.send_test_email(p_company uuid, p_template text, p_to text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.require_permission(p_company, 'emails.manage');
  if (select count(*) from public.email_logs where company_id = p_company and template_key = p_template
      and dedupe_key like 'test:%' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Test email limit reached. Try again later.';
  end if;
  v_id := public.enqueue_email(p_company, p_template, p_to, 'Test Recipient',
    jsonb_build_object('candidate_name', 'Alex Candidate', 'employee_name', 'Alex Employee', 'job_title', 'Software Engineer',
      'round_name', 'Technical Round', 'interview_date', to_char(now() + interval '2 days', 'Dy, DD Mon YYYY'), 'interview_time', '11:00 AM',
      'timezone', public.company_tz(p_company), 'duration', '60', 'interview_type', 'Video', 'meeting_link', 'https://meet.example.com/test',
      'ctc', '₹ 12,00,000', 'joining_date', public.fmt_date(current_date + 30), 'expiry_date', public.fmt_date(current_date + 7),
      'offer_link', '#test-link', 'employee_code', 'EMP-0001', 'login_link', '#', 'invite_link', '#', 'role_name', 'Employee',
      'leave_type', 'Casual Leave', 'start_date', public.fmt_date(current_date), 'end_date', public.fmt_date(current_date + 1),
      'days', '2', 'decision', 'approved', 'period', to_char(now(), 'FMMonth YYYY'), 'net_pay', '₹ 85,000',
      'work_location', 'Head Office', 'reporting_time', '09:30 AM'),
    'test:' || gen_random_uuid(), 'email_templates', null);
  return v_id;
end $$;
