-- =====================================================================
-- 0900  READ VIEWS (security_invoker => caller's RLS applies) + STORAGE
-- =====================================================================

create view public.v_members with (security_invoker = true) as
select m.id, m.company_id, m.user_id, m.role_id, m.employee_id, m.status, m.created_at,
  p.email, p.full_name, r.name as role_name, r.is_admin,
  e.employee_code, trim(e.first_name || ' ' || e.last_name) as employee_name
from public.company_members m
join public.profiles p on p.id = m.user_id
join public.roles r on r.id = m.role_id
left join public.employees e on e.id = m.employee_id;

create view public.v_invitations with (security_invoker = true) as
select i.*, r.name as role_name, p.full_name as invited_by_name
from public.company_invitations i
join public.roles r on r.id = i.role_id
left join public.profiles p on p.id = i.invited_by;

create view public.v_roles with (security_invoker = true) as
select r.*, (select count(*) from public.company_members m where m.role_id = r.id) as member_count,
  case when r.is_admin then (select count(*) from public.permissions)
       else (select count(*) from public.role_permissions rp where rp.role_id = r.id) end as permission_count
from public.roles r;

create view public.v_departments with (security_invoker = true) as
select d.*, pd.name as parent_name, trim(h.first_name || ' ' || h.last_name) as head_name,
  (select count(*) from public.employees e where e.department_id = d.id and e.status not in ('inactive','terminated')) as employee_count
from public.departments d
left join public.departments pd on pd.id = d.parent_id
left join public.employees h on h.id = d.head_employee_id;

create view public.v_designations with (security_invoker = true) as
select g.*, d.name as department_name,
  (select count(*) from public.employees e where e.designation_id = g.id and e.status not in ('inactive','terminated')) as employee_count
from public.designations g left join public.departments d on d.id = g.department_id;

create view public.v_employees with (security_invoker = true) as
select e.*, trim(e.first_name || ' ' || e.last_name) as full_name, d.name as department_name, g.title as designation_title,
  trim(m.first_name || ' ' || m.last_name) as manager_name
from public.employees e
left join public.departments d on d.id = e.department_id
left join public.designations g on g.id = e.designation_id
left join public.employees m on m.id = e.manager_id;

create view public.v_requisitions with (security_invoker = true) as
select r.*, d.name as department_name, g.title as designation_title,
  coalesce(rp.full_name, rp.email) as requested_by_name, coalesce(ap.full_name, ap.email) as approved_by_name,
  (select count(*) from public.jobs j where j.requisition_id = r.id) as jobs_count
from public.job_requisitions r
left join public.departments d on d.id = r.department_id
left join public.designations g on g.id = r.designation_id
left join public.profiles rp on rp.id = r.requested_by
left join public.profiles ap on ap.id = r.approved_by;

create view public.v_jobs with (security_invoker = true) as
select j.*, d.name as department_name, g.title as designation_title, coalesce(hm.full_name, hm.email) as hiring_manager_name,
  (select count(*) from public.applications a where a.job_id = j.id) as applications_count,
  (select count(*) from public.applications a where a.job_id = j.id
     and a.stage in ('applied','screening','shortlisted','interview','selected','offered','on_hold')) as active_count,
  (select count(*) from public.applications a where a.job_id = j.id and a.stage = 'hired') as hired_count
from public.jobs j
left join public.departments d on d.id = j.department_id
left join public.designations g on g.id = j.designation_id
left join public.profiles hm on hm.id = j.hiring_manager_id;

create view public.v_candidates with (security_invoker = true) as
select c.*, trim(c.first_name || ' ' || c.last_name) as full_name,
  (select count(*) from public.applications a where a.candidate_id = c.id) as applications_count,
  la.stage as latest_stage, la.job_title as latest_job_title, la.applied_at as last_applied_at,
  exists (select 1 from public.candidate_documents cd where cd.candidate_id = c.id and cd.doc_type = 'resume') as has_resume
from public.candidates c
left join lateral (select a.stage, j.title as job_title, a.applied_at from public.applications a
                   join public.jobs j on j.id = a.job_id where a.candidate_id = c.id order by a.applied_at desc limit 1) la on true;

create view public.v_applications with (security_invoker = true) as
select a.*, trim(c.first_name || ' ' || c.last_name) as candidate_name, c.email as candidate_email, c.phone as candidate_phone,
  c.experience_years, c.current_title, c.current_company, c.current_location, c.skills, c.expected_ctc, c.notice_period_days,
  j.title as job_title, j.department_id, d.name as department_name,
  (select count(*) from public.interviews i where i.application_id = a.id and i.status <> 'cancelled') as interviews_count,
  (select round(avg(f.overall_rating), 1) from public.interview_feedback f join public.interviews i on i.id = f.interview_id
     where i.application_id = a.id) as avg_feedback_rating,
  (select cd.id from public.candidate_documents cd where cd.application_id = a.id and cd.doc_type = 'resume' order by cd.created_at desc limit 1) as resume_document_id
from public.applications a
join public.candidates c on c.id = a.candidate_id
join public.jobs j on j.id = a.job_id
left join public.departments d on d.id = j.department_id;

create view public.v_interviews with (security_invoker = true) as
select i.*, i.scheduled_at + make_interval(mins => i.duration_minutes) as ends_at,
  a.candidate_id, a.job_id, a.stage as application_stage,
  trim(c.first_name || ' ' || c.last_name) as candidate_name, c.email as candidate_email, j.title as job_title,
  coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, p.email), 'email', p.email) order by p.full_name)
            from public.interview_panelists ip join public.profiles p on p.id = ip.user_id where ip.interview_id = i.id), '[]') as panelists,
  (select array_agg(ip.user_id) from public.interview_panelists ip where ip.interview_id = i.id) as panelist_ids,
  (select count(*) from public.interview_feedback f where f.interview_id = i.id) as feedback_count
from public.interviews i
join public.applications a on a.id = i.application_id
join public.candidates c on c.id = a.candidate_id
join public.jobs j on j.id = a.job_id;

create view public.v_feedback with (security_invoker = true) as
select f.*, coalesce(p.full_name, p.email) as interviewer_name, i.round_name, i.scheduled_at, i.application_id
from public.interview_feedback f
join public.interviews i on i.id = f.interview_id
left join public.profiles p on p.id = f.interviewer_id;

create view public.v_offers with (security_invoker = true) as
select o.id, o.company_id, o.offer_number, o.application_id, o.candidate_id, o.job_id, o.designation_id, o.department_id,
  o.reporting_manager_id, o.employment_type, o.work_location, o.ctc_annual, o.basic_monthly, o.hra_monthly,
  o.allowances_monthly, o.joining_date, o.expiry_date, o.probation_months, o.additional_terms, o.status, o.pdf_path,
  o.token_expires_at, o.sent_at, o.viewed_at, o.responded_at, o.candidate_signature, o.decline_reason, o.approved_by,
  o.approved_at, o.created_by, o.created_at, o.updated_at,
  trim(c.first_name || ' ' || c.last_name) as candidate_name, c.email as candidate_email, j.title as job_title,
  g.title as designation_title, d.name as department_name, trim(m.first_name || ' ' || m.last_name) as reporting_manager_name,
  coalesce(cp.full_name, cp.email) as created_by_name, coalesce(ap.full_name, ap.email) as approved_by_name
from public.offers o
join public.candidates c on c.id = o.candidate_id
join public.jobs j on j.id = o.job_id
left join public.designations g on g.id = o.designation_id
left join public.departments d on d.id = o.department_id
left join public.employees m on m.id = o.reporting_manager_id
left join public.profiles cp on cp.id = o.created_by
left join public.profiles ap on ap.id = o.approved_by;

create view public.v_onboardings with (security_invoker = true) as
select ob.*, trim(c.first_name || ' ' || c.last_name) as candidate_name, c.email as candidate_email, c.phone as candidate_phone,
  j.title as job_title, o.offer_number, g.title as designation_title, d.name as department_name, e.employee_code,
  (select count(*) from public.onboarding_tasks t where t.onboarding_id = ob.id) as tasks_total,
  (select count(*) from public.onboarding_tasks t where t.onboarding_id = ob.id and t.is_completed) as tasks_done
from public.onboardings ob
join public.candidates c on c.id = ob.candidate_id
join public.offers o on o.id = ob.offer_id
join public.jobs j on j.id = o.job_id
left join public.designations g on g.id = o.designation_id
left join public.departments d on d.id = o.department_id
left join public.employees e on e.id = ob.employee_id;

create view public.v_attendance with (security_invoker = true) as
select a.*, e.employee_code, trim(e.first_name || ' ' || e.last_name) as employee_name, e.department_id, d.name as department_name
from public.attendance_records a
join public.employees e on e.id = a.employee_id
left join public.departments d on d.id = e.department_id;

create view public.v_leave_requests with (security_invoker = true) as
select r.*, e.employee_code, trim(e.first_name || ' ' || e.last_name) as employee_name, e.manager_id, e.department_id,
  d.name as department_name, lt.name as leave_type_name, lt.color as leave_type_color, lt.is_paid,
  coalesce(p.full_name, p.email) as approver_name
from public.leave_requests r
join public.employees e on e.id = r.employee_id
join public.leave_types lt on lt.id = r.leave_type_id
left join public.departments d on d.id = e.department_id
left join public.profiles p on p.id = r.approver_id;

create view public.v_leave_balances with (security_invoker = true) as
select b.*, b.allocated - b.used as available, e.employee_code, trim(e.first_name || ' ' || e.last_name) as employee_name,
  lt.name as leave_type_name, lt.color as leave_type_color, lt.code as leave_type_code
from public.leave_balances b
join public.employees e on e.id = b.employee_id
join public.leave_types lt on lt.id = b.leave_type_id;

create view public.v_payslips with (security_invoker = true) as
select p.*, e.employee_code, trim(e.first_name || ' ' || e.last_name) as employee_name, e.email as employee_email,
  e.pan_number, e.bank_name, right(e.bank_account_number, 4) as bank_account_last4, e.joining_date,
  d.name as department_name, g.title as designation_title, r.period_year, r.period_month, r.status as run_status
from public.payslips p
join public.employees e on e.id = p.employee_id
join public.payroll_runs r on r.id = p.payroll_run_id
left join public.departments d on d.id = e.department_id
left join public.designations g on g.id = e.designation_id;

create view public.v_audit_logs with (security_invoker = true) as
select a.*, coalesce(p.full_name, p.email, 'System') as actor_name, p.email as actor_email
from public.audit_logs a left join public.profiles p on p.id = a.actor_id;

create view public.v_admin_companies with (security_invoker = true) as
select c.id, c.name, c.slug, c.email, c.status, c.plan, c.max_employees, c.country, c.created_at,
  (select count(*) from public.company_members m where m.company_id = c.id and m.status = 'active') as member_count,
  (select count(*) from public.employees e where e.company_id = c.id and e.status not in ('inactive','terminated')) as employee_count,
  (select count(*) from public.jobs j where j.company_id = c.id and j.status = 'published') as open_jobs,
  (select p.email from public.profiles p where p.id = c.created_by) as created_by_email
from public.companies c
where public.is_super_admin();

revoke all on all tables in schema public from anon;

-- =====================================================================
-- STORAGE  (private buckets; object path always starts with company_id)
--   resumes/<company_id>/incoming/<uuid>/<file>   public careers uploads (insert-only for anon)
--   resumes/<company_id>/candidates/<candidate_id>/<file>
--   documents/<company_id>/offers/<offer_id>.pdf
--   documents/<company_id>/employees/<employee_id>/<file>
--   company-assets/<company_id>/logo.<ext>        public read (logos on careers page)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('resumes', 'resumes', false, 5242880, array['application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('documents', 'documents', false, 10485760, array['application/pdf','image/png','image/jpeg',
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('company-assets', 'company-assets', true, 1048576, array['image/png','image/jpeg','image/svg+xml','image/webp'])
on conflict (id) do nothing;

create or replace function public.storage_company(p_name text) returns uuid
language sql immutable as $$ select public.try_uuid(split_part(p_name, '/', 1)) $$;

create or replace function public.careers_upload_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select split_part(p_name, '/', 2) = 'incoming'
     and public.try_uuid(split_part(p_name, '/', 3)) is not null
     and p_name not like '%..%'
     and exists (select 1 from public.companies c where c.id = public.storage_company(p_name)
                 and c.careers_enabled and c.status <> 'suspended')
$$;
grant execute on function public.careers_upload_allowed(text) to anon, authenticated;

create policy "careers resume upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'resumes' and public.careers_upload_allowed(name));
create policy "recruiters read resumes" on storage.objects for select to authenticated
  using (bucket_id = 'resumes' and (public.has_permission(public.storage_company(name), 'candidates.view')
         or exists (select 1 from public.candidate_documents cd where cd.storage_path = name and public.is_candidate_panelist(cd.candidate_id))));
create policy "recruiters write resumes" on storage.objects for insert to authenticated
  with check (bucket_id = 'resumes' and split_part(name, '/', 2) = 'candidates'
              and public.has_permission(public.storage_company(name), 'candidates.manage'));
create policy "recruiters delete resumes" on storage.objects for delete to authenticated
  using (bucket_id = 'resumes' and public.has_permission(public.storage_company(name), 'candidates.manage'));

create or replace function public.can_access_document(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'offers' then public.has_permission(public.storage_company(p_name), case when p_write then 'offers.manage' else 'offers.view' end)
    when 'employees' then public.has_permission(public.storage_company(p_name), case when p_write then 'employees.manage' else 'employees.view' end)
                          or (not p_write and public.try_uuid(split_part(p_name, '/', 3)) = public.my_employee_id(public.storage_company(p_name)))
    when 'candidates' then public.has_permission(public.storage_company(p_name), case when p_write then 'candidates.manage' else 'candidates.view' end)
    else false end
$$;
create policy "read documents" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.can_access_document(name, false));
create policy "write documents" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.can_access_document(name, true));
create policy "update documents" on storage.objects for update to authenticated
  using (bucket_id = 'documents' and public.can_access_document(name, true));
create policy "delete documents" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.can_access_document(name, true));

create policy "public read company assets" on storage.objects for select to anon, authenticated
  using (bucket_id = 'company-assets');
create policy "settings managers write assets" on storage.objects for insert to authenticated
  with check (bucket_id = 'company-assets' and public.has_permission(public.storage_company(name), 'settings.manage'));
create policy "settings managers update assets" on storage.objects for update to authenticated
  using (bucket_id = 'company-assets' and public.has_permission(public.storage_company(name), 'settings.manage'));
create policy "settings managers delete assets" on storage.objects for delete to authenticated
  using (bucket_id = 'company-assets' and public.has_permission(public.storage_company(name), 'settings.manage'));
