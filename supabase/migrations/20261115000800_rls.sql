-- =====================================================================
-- 0800  SECURITY: integrity guards + Row Level Security policies
-- Principle: every tenant table is filtered by company_id through
-- is_member()/has_permission(); writes that carry business rules go
-- through SECURITY DEFINER RPCs (direct API writes are blocked by guards).
-- In SECURITY DEFINER functions current_user is the function owner, while
-- direct PostgREST calls run as 'authenticated'/'anon' — guards use this.
-- =====================================================================

create or replace function public.is_api_role() returns boolean
language sql stable as $$ select current_user in ('authenticated', 'anon') $$;

-- ---------- guards ----------
create or replace function public.guard_companies() returns trigger
language plpgsql as $$
begin
  if public.is_api_role() and not public.is_super_admin() then
    if new.status is distinct from old.status or new.plan is distinct from old.plan
       or new.max_employees is distinct from old.max_employees or new.slug is distinct from old.slug
       or new.employee_code_seq is distinct from old.employee_code_seq or new.created_by is distinct from old.created_by then
      raise exception 'Only the platform administrator can change plan, status, limits or URL slug' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger trg_guard_companies before update on public.companies for each row execute function public.guard_companies();

create or replace function public.guard_profiles() returns trigger
language plpgsql as $$
begin
  if public.is_api_role() then new.email := old.email; new.id := old.id; end if;
  return new;
end $$;
create trigger trg_guard_profiles before update on public.profiles for each row execute function public.guard_profiles();

create or replace function public.guard_roles() returns trigger
language plpgsql as $$
begin
  if not public.is_api_role() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if old.is_system then raise exception 'System roles cannot be deleted'; end if;
    if exists (select 1 from public.company_members where role_id = old.id) then
      raise exception 'This role is assigned to users. Reassign them first.';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then new.is_system := false; new.is_admin := false; return new; end if;
  if new.is_admin is distinct from old.is_admin or new.is_system is distinct from old.is_system
     or new.company_id is distinct from old.company_id then
    raise exception 'Role type cannot be changed';
  end if;
  if old.is_system and new.name is distinct from old.name then raise exception 'System roles cannot be renamed'; end if;
  return new;
end $$;
create trigger trg_guard_roles before insert or update or delete on public.roles for each row execute function public.guard_roles();

create or replace function public.guard_role_permissions() returns trigger
language plpgsql as $$
declare v_role public.roles;
begin
  select * into v_role from public.roles where id = coalesce(new.role_id, old.role_id);
  if public.is_api_role() and v_role.is_admin then raise exception 'The Company Admin role always has every permission'; end if;
  return coalesce(new, old);
end $$;
create trigger trg_guard_role_permissions before insert or delete on public.role_permissions for each row execute function public.guard_role_permissions();

create or replace function public.guard_members() returns trigger
language plpgsql as $$
declare v_admins integer;
begin
  if not public.is_api_role() then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.company_id is distinct from old.company_id then
      raise exception 'Membership owner cannot be changed';
    end if;
    if old.user_id = auth.uid() and (new.role_id is distinct from old.role_id or new.status <> 'active') and not public.is_super_admin() then
      raise exception 'You cannot change your own role or deactivate yourself';
    end if;
    if new.role_id is not null and not exists (select 1 from public.roles where id = new.role_id and company_id = new.company_id) then
      raise exception 'Invalid role';
    end if;
  elsif tg_op = 'DELETE' and old.user_id = auth.uid() and not public.is_super_admin() then
    raise exception 'You cannot remove yourself';
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_guard_members before update or delete on public.company_members for each row execute function public.guard_members();

-- after-statement check: at least one active admin must remain
create or replace function public.guard_last_admin() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  for v_company in select distinct company_id from (select company_id from old_rows) x loop
    if exists (select 1 from public.companies where id = v_company)
       and not exists (select 1 from public.company_members m join public.roles r on r.id = m.role_id
                       where m.company_id = v_company and m.status = 'active' and r.is_admin) then
      raise exception 'A company must keep at least one active Company Admin';
    end if;
  end loop;
  return null;
end $$;
create trigger trg_guard_last_admin_upd after update on public.company_members
  referencing old table as old_rows for each statement execute function public.guard_last_admin();
create trigger trg_guard_last_admin_del after delete on public.company_members
  referencing old table as old_rows for each statement execute function public.guard_last_admin();

create or replace function public.guard_applications() returns trigger
language plpgsql as $$
begin
  if public.is_api_role() then
    if tg_op = 'INSERT' and new.stage not in ('applied','screening','shortlisted') then
      raise exception 'New applications must start in applied, screening or shortlisted';
    end if;
    if tg_op = 'UPDATE' and (new.stage is distinct from old.stage or new.job_id is distinct from old.job_id
                             or new.candidate_id is distinct from old.candidate_id) then
      raise exception 'Use the pipeline actions to change an application stage';
    end if;
    if tg_op = 'INSERT' then
      if not exists (select 1 from public.jobs where id = new.job_id and company_id = new.company_id)
         or not exists (select 1 from public.candidates where id = new.candidate_id and company_id = new.company_id) then
        raise exception 'Job and candidate must belong to the same company';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger trg_guard_applications before insert or update on public.applications for each row execute function public.guard_applications();

create or replace function public.guard_requisitions() returns trigger
language plpgsql as $$
declare v_admin boolean;
begin
  if not public.is_api_role() then return new; end if;
  if tg_op = 'INSERT' then
    new.requested_by := auth.uid();
    if new.status not in ('draft','pending_approval') then raise exception 'New requisitions must be draft or submitted'; end if;
    new.approved_by := null; new.approved_at := null;
    return new;
  end if;
  if new.status is distinct from old.status then
    if new.status in ('approved','rejected') then
      if old.status <> 'pending_approval' then raise exception 'Only submitted requisitions can be approved or rejected'; end if;
      if not public.has_permission(new.company_id, 'requisitions.approve') then
        raise exception 'You do not have permission to approve requisitions' using errcode = '42501';
      end if;
      select r.is_admin into v_admin from public.company_members m join public.roles r on r.id = m.role_id
        where m.company_id = new.company_id and m.user_id = auth.uid();
      if old.requested_by = auth.uid() and not coalesce(v_admin, false) and not public.is_super_admin() then
        raise exception 'You cannot approve your own requisition';
      end if;
      new.approved_by := auth.uid(); new.approved_at := now();
    elsif new.status = 'pending_approval' and old.status not in ('draft','rejected') then
      raise exception 'Only draft or rejected requisitions can be submitted';
    elsif new.status = 'draft' and old.status not in ('rejected','pending_approval') then
      raise exception 'Invalid status change';
    end if;
  elsif old.status in ('approved','closed') and (new.headcount is distinct from old.headcount or new.max_salary is distinct from old.max_salary) then
    raise exception 'Approved requisitions cannot change headcount or budget';
  end if;
  new.requested_by := old.requested_by;
  return new;
end $$;
create trigger trg_guard_requisitions before insert or update on public.job_requisitions for each row execute function public.guard_requisitions();

-- cross-tenant reference protection for common FK columns written from the client
create or replace function public.guard_same_company() returns trigger
language plpgsql security definer set search_path = public as $$
declare col text; v_id uuid; v_tbl text; v_ok integer;
begin
  foreach col in array tg_argv loop
    v_tbl := split_part(col, ':', 2);
    v_id := (to_jsonb(new) ->> split_part(col, ':', 1))::uuid;
    if v_id is not null then
      v_ok := null;
      execute format('select 1 from public.%I where id = $1 and company_id = $2', v_tbl) into v_ok using v_id, new.company_id;
      if v_ok is null then raise exception 'Invalid reference: % does not belong to this company', split_part(col, ':', 1); end if;
    end if;
  end loop;
  return new;
end $$;
create trigger trg_same_company before insert or update on public.employees for each row
  execute function public.guard_same_company('department_id:departments', 'designation_id:designations', 'manager_id:employees');
create trigger trg_same_company before insert or update on public.designations for each row
  execute function public.guard_same_company('department_id:departments');
create trigger trg_same_company before insert or update on public.departments for each row
  execute function public.guard_same_company('parent_id:departments', 'head_employee_id:employees');
create trigger trg_same_company before insert or update on public.jobs for each row
  execute function public.guard_same_company('department_id:departments', 'designation_id:designations', 'requisition_id:job_requisitions');
create trigger trg_same_company before insert or update on public.job_requisitions for each row
  execute function public.guard_same_company('department_id:departments', 'designation_id:designations');
create trigger trg_same_company before insert or update on public.offers for each row
  execute function public.guard_same_company('department_id:departments', 'designation_id:designations', 'reporting_manager_id:employees');
create trigger trg_same_company before insert or update on public.attendance_records for each row
  execute function public.guard_same_company('employee_id:employees');
create trigger trg_same_company before insert or update on public.leave_balances for each row
  execute function public.guard_same_company('employee_id:employees', 'leave_type_id:leave_types');
create trigger trg_same_company before insert or update on public.candidate_notes for each row
  execute function public.guard_same_company('candidate_id:candidates');
create trigger trg_same_company before insert or update on public.candidate_documents for each row
  execute function public.guard_same_company('candidate_id:candidates', 'application_id:applications');
create trigger trg_same_company before insert or update on public.onboarding_tasks for each row
  execute function public.guard_same_company('onboarding_id:onboardings');

create or replace function public.guard_employee_self_link() returns trigger
language plpgsql as $$
begin
  -- user_id (login link) is managed by invitations, never directly from the API
  if public.is_api_role() and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) then
    new.user_id := case when tg_op = 'INSERT' then null else old.user_id end;
  end if;
  return new;
end $$;
create trigger trg_guard_employee_link before insert or update on public.employees for each row execute function public.guard_employee_self_link();

-- ---------- visibility helpers for interview panelists ----------
create or replace function public.is_interview_panelist(p_interview uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.interview_panelists where interview_id = p_interview and user_id = auth.uid())
$$;
create or replace function public.is_application_panelist(p_application uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.interviews i join public.interview_panelists p on p.interview_id = i.id
                 where i.application_id = p_application and p.user_id = auth.uid())
$$;
create or replace function public.is_candidate_panelist(p_candidate uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.applications a join public.interviews i on i.application_id = a.id
                 join public.interview_panelists p on p.interview_id = i.id
                 where a.candidate_id = p_candidate and p.user_id = auth.uid())
$$;
create or replace function public.is_job_panelist(p_job uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.applications a join public.interviews i on i.application_id = a.id
                 join public.interview_panelists p on p.interview_id = i.id
                 where a.job_id = p_job and p.user_id = auth.uid())
$$;
create or replace function public.manages_employee(p_employee uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.employees e where e.id = p_employee and e.manager_id is not null
                 and e.manager_id = public.my_employee_id(e.company_id))
$$;
create or replace function public.payroll_run_released(p_run uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.payroll_runs where id = p_run and status in ('processed','paid'))
$$;

-- ---------- enable RLS everywhere ----------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------- platform ----------
create policy "own platform admin row" on public.platform_admins for select to authenticated
  using (user_id = auth.uid() or public.is_super_admin());

create policy "members read company" on public.companies for select to authenticated using (public.is_member(id));
create policy "settings managers update company" on public.companies for update to authenticated
  using (public.has_permission(id, 'settings.manage')) with check (public.has_permission(id, 'settings.manage'));
create policy "super admin deletes company" on public.companies for delete to authenticated using (public.is_super_admin());

create policy "read profiles in shared companies" on public.profiles for select to authenticated using (public.shares_company(id));
create policy "update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "read permission catalog" on public.permissions for select to authenticated using (true);

create policy "members read roles" on public.roles for select to authenticated using (public.is_member(company_id));
create policy "user admins write roles" on public.roles for all to authenticated
  using (public.has_permission(company_id, 'users.manage')) with check (public.has_permission(company_id, 'users.manage'));

create policy "members read role permissions" on public.role_permissions for select to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id and public.is_member(r.company_id)));
create policy "user admins write role permissions" on public.role_permissions for all to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id and public.has_permission(r.company_id, 'users.manage')))
  with check (exists (select 1 from public.roles r where r.id = role_id and public.has_permission(r.company_id, 'users.manage')));

create policy "members read memberships" on public.company_members for select to authenticated
  using (public.is_member(company_id) or user_id = auth.uid());
create policy "user admins update memberships" on public.company_members for update to authenticated
  using (public.has_permission(company_id, 'users.manage')) with check (public.has_permission(company_id, 'users.manage'));
create policy "user admins delete memberships" on public.company_members for delete to authenticated
  using (public.has_permission(company_id, 'users.manage'));

create policy "user admins manage invitations" on public.company_invitations for select to authenticated
  using (public.has_permission(company_id, 'users.manage'));
create policy "user admins revoke invitations" on public.company_invitations for update to authenticated
  using (public.has_permission(company_id, 'users.manage')) with check (public.has_permission(company_id, 'users.manage'));
create policy "user admins delete invitations" on public.company_invitations for delete to authenticated
  using (public.has_permission(company_id, 'users.manage'));

-- ---------- organization ----------
create policy "members read departments" on public.departments for select to authenticated using (public.is_member(company_id));
create policy "org managers write departments" on public.departments for all to authenticated
  using (public.has_permission(company_id, 'departments.manage')) with check (public.has_permission(company_id, 'departments.manage'));
create policy "members read designations" on public.designations for select to authenticated using (public.is_member(company_id));
create policy "org managers write designations" on public.designations for all to authenticated
  using (public.has_permission(company_id, 'departments.manage')) with check (public.has_permission(company_id, 'departments.manage'));

create policy "read employees" on public.employees for select to authenticated using (
  public.has_permission(company_id, 'employees.view') or id = public.my_employee_id(company_id) or public.manages_employee(id));
create policy "employee managers insert" on public.employees for insert to authenticated
  with check (public.has_permission(company_id, 'employees.manage'));
create policy "employee managers update" on public.employees for update to authenticated
  using (public.has_permission(company_id, 'employees.manage')) with check (public.has_permission(company_id, 'employees.manage'));
create policy "employee managers delete" on public.employees for delete to authenticated
  using (public.has_permission(company_id, 'employees.manage'));

-- ---------- attendance ----------
create policy "members read holidays" on public.holidays for select to authenticated using (public.is_member(company_id));
create policy "attendance managers write holidays" on public.holidays for all to authenticated
  using (public.has_permission(company_id, 'attendance.manage')) with check (public.has_permission(company_id, 'attendance.manage'));

create policy "read attendance" on public.attendance_records for select to authenticated using (
  public.has_permission(company_id, 'attendance.view') or employee_id = public.my_employee_id(company_id) or public.manages_employee(employee_id));
create policy "attendance managers write" on public.attendance_records for all to authenticated
  using (public.has_permission(company_id, 'attendance.manage')) with check (public.has_permission(company_id, 'attendance.manage'));

-- ---------- leave ----------
create policy "members read leave types" on public.leave_types for select to authenticated using (public.is_member(company_id));
create policy "leave managers write types" on public.leave_types for all to authenticated
  using (public.has_permission(company_id, 'leave.manage')) with check (public.has_permission(company_id, 'leave.manage'));

create policy "read leave balances" on public.leave_balances for select to authenticated using (
  public.has_permission(company_id, 'leave.view') or employee_id = public.my_employee_id(company_id) or public.manages_employee(employee_id));
create policy "leave managers write balances" on public.leave_balances for all to authenticated
  using (public.has_permission(company_id, 'leave.manage')) with check (public.has_permission(company_id, 'leave.manage'));

create policy "read leave requests" on public.leave_requests for select to authenticated using (
  public.has_permission(company_id, 'leave.view') or public.has_permission(company_id, 'leave.approve')
  or employee_id = public.my_employee_id(company_id) or public.manages_employee(employee_id));

-- ---------- payroll ----------
create policy "payroll viewers read runs" on public.payroll_runs for select to authenticated
  using (public.has_permission(company_id, 'payroll.view'));
create policy "employees read released runs with own payslip" on public.payroll_runs for select to authenticated using (
  status in ('processed','paid') and exists (select 1 from public.payslips p
    where p.payroll_run_id = payroll_runs.id and p.employee_id = public.my_employee_id(payroll_runs.company_id)));
create policy "payroll managers delete draft runs" on public.payroll_runs for delete to authenticated
  using (public.has_permission(company_id, 'payroll.manage') and status = 'draft');
create policy "read payslips" on public.payslips for select to authenticated using (
  public.has_permission(company_id, 'payroll.view')
  or (employee_id = public.my_employee_id(company_id) and public.payroll_run_released(payroll_run_id)));

-- ---------- recruitment ----------
create policy "read requisitions" on public.job_requisitions for select to authenticated using (
  public.has_permission(company_id, 'requisitions.view') or public.has_permission(company_id, 'requisitions.approve') or requested_by = auth.uid());
create policy "requisition managers insert" on public.job_requisitions for insert to authenticated
  with check (public.has_permission(company_id, 'requisitions.manage'));
create policy "requisition managers/approvers update" on public.job_requisitions for update to authenticated
  using (public.has_permission(company_id, 'requisitions.manage') or public.has_permission(company_id, 'requisitions.approve'))
  with check (public.has_permission(company_id, 'requisitions.manage') or public.has_permission(company_id, 'requisitions.approve'));
create policy "requisition managers delete drafts" on public.job_requisitions for delete to authenticated
  using (public.has_permission(company_id, 'requisitions.manage') and status in ('draft','rejected'));

create policy "read jobs" on public.jobs for select to authenticated using (
  public.has_permission(company_id, 'jobs.view') or public.has_permission(company_id, 'candidates.view')
  or hiring_manager_id = auth.uid() or public.is_job_panelist(id));
create policy "job managers write" on public.jobs for all to authenticated
  using (public.has_permission(company_id, 'jobs.manage')) with check (public.has_permission(company_id, 'jobs.manage'));

create policy "read candidates" on public.candidates for select to authenticated using (
  public.has_permission(company_id, 'candidates.view') or public.is_candidate_panelist(id));
create policy "candidate managers write" on public.candidates for all to authenticated
  using (public.has_permission(company_id, 'candidates.manage')) with check (public.has_permission(company_id, 'candidates.manage'));

create policy "read applications" on public.applications for select to authenticated using (
  public.has_permission(company_id, 'candidates.view') or public.is_application_panelist(id)
  or exists (select 1 from public.jobs j where j.id = job_id and j.hiring_manager_id = auth.uid()));
create policy "candidate managers write applications" on public.applications for all to authenticated
  using (public.has_permission(company_id, 'candidates.manage')) with check (public.has_permission(company_id, 'candidates.manage'));

create policy "read stage history" on public.application_stage_history for select to authenticated using (
  public.has_permission(company_id, 'candidates.view') or public.is_application_panelist(application_id));

create policy "read candidate notes" on public.candidate_notes for select to authenticated
  using (public.has_permission(company_id, 'candidates.view'));
create policy "add candidate notes" on public.candidate_notes for insert to authenticated
  with check (public.has_permission(company_id, 'candidates.view') and created_by = auth.uid());
create policy "delete own notes" on public.candidate_notes for delete to authenticated
  using (created_by = auth.uid() or public.has_permission(company_id, 'candidates.manage'));

create policy "read candidate documents" on public.candidate_documents for select to authenticated using (
  public.has_permission(company_id, 'candidates.view') or public.is_candidate_panelist(candidate_id));
create policy "candidate managers write documents" on public.candidate_documents for all to authenticated
  using (public.has_permission(company_id, 'candidates.manage')) with check (public.has_permission(company_id, 'candidates.manage'));

create policy "read interviews" on public.interviews for select to authenticated using (
  public.has_permission(company_id, 'interviews.view') or public.has_permission(company_id, 'candidates.view')
  or public.is_interview_panelist(id));
create policy "interview managers update notes" on public.interviews for update to authenticated
  using (public.has_permission(company_id, 'interviews.manage')) with check (public.has_permission(company_id, 'interviews.manage'));
create policy "interview managers delete" on public.interviews for delete to authenticated
  using (public.has_permission(company_id, 'interviews.manage'));

create policy "read panelists" on public.interview_panelists for select to authenticated using (
  public.has_permission(company_id, 'interviews.view') or public.has_permission(company_id, 'candidates.view')
  or public.is_interview_panelist(interview_id));

create policy "read feedback" on public.interview_feedback for select to authenticated using (
  public.has_permission(company_id, 'interviews.view') or public.has_permission(company_id, 'candidates.manage')
  or interviewer_id = auth.uid());

create policy "read offers" on public.offers for select to authenticated using (
  public.has_permission(company_id, 'offers.view') or public.has_permission(company_id, 'offers.approve'));
create policy "offer managers insert" on public.offers for insert to authenticated
  with check (public.has_permission(company_id, 'offers.manage'));
create policy "offer managers update" on public.offers for update to authenticated
  using (public.has_permission(company_id, 'offers.manage')) with check (public.has_permission(company_id, 'offers.manage'));
create policy "offer managers delete drafts" on public.offers for delete to authenticated
  using (public.has_permission(company_id, 'offers.manage') and status in ('draft','rejected'));

create policy "read offer history" on public.offer_approvals for select to authenticated using (
  public.has_permission(company_id, 'offers.view') or public.has_permission(company_id, 'offers.approve'));

create policy "read onboarding templates" on public.onboarding_task_templates for select to authenticated
  using (public.has_permission(company_id, 'onboarding.view'));
create policy "onboarding managers write templates" on public.onboarding_task_templates for all to authenticated
  using (public.has_permission(company_id, 'onboarding.manage')) with check (public.has_permission(company_id, 'onboarding.manage'));
create policy "read onboardings" on public.onboardings for select to authenticated
  using (public.has_permission(company_id, 'onboarding.view'));
create policy "onboarding managers update" on public.onboardings for update to authenticated
  using (public.has_permission(company_id, 'onboarding.manage')) with check (public.has_permission(company_id, 'onboarding.manage'));
create policy "read onboarding tasks" on public.onboarding_tasks for select to authenticated
  using (public.has_permission(company_id, 'onboarding.view'));
create policy "onboarding managers write tasks" on public.onboarding_tasks for all to authenticated
  using (public.has_permission(company_id, 'onboarding.manage')) with check (public.has_permission(company_id, 'onboarding.manage'));

-- ---------- communications ----------
create policy "email managers templates" on public.email_templates for all to authenticated
  using (public.has_permission(company_id, 'emails.manage')) with check (public.has_permission(company_id, 'emails.manage'));
create policy "email managers read logs" on public.email_logs for select to authenticated
  using (public.has_permission(company_id, 'emails.manage'));

create policy "own notifications read" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "own notifications update" on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own notifications delete" on public.notifications for delete to authenticated using (user_id = auth.uid());

create policy "auditors read audit logs" on public.audit_logs for select to authenticated using (
  public.is_super_admin() or (company_id is not null and public.has_permission(company_id, 'audit.view')));

-- public_submission_log: RLS enabled with no policies => no API access at all.

-- ---------- privileges hardening ----------
revoke all on public.public_submission_log from anon, authenticated;
revoke insert, update, delete on public.audit_logs, public.email_logs, public.application_stage_history,
  public.offer_approvals, public.payslips, public.interview_feedback, public.permissions, public.platform_admins
  from anon, authenticated;
-- anonymous visitors only use the SECURITY DEFINER public_* RPCs
revoke all on all tables in schema public from anon;
