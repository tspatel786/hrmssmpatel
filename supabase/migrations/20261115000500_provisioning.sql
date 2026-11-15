-- =====================================================================
-- 0500  PROVISIONING: formatting helpers, company defaults, company
--       creation, invitations, super-admin operations
-- =====================================================================

create or replace function public.fmt_date(d date) returns text
language sql immutable as $$ select to_char(d, 'DD Mon YYYY') $$;

create or replace function public.fmt_money(n numeric, cur text) returns text
language sql immutable as $$ select coalesce(cur, 'INR') || ' ' || to_char(coalesce(n, 0), 'FM999,999,999,990') $$;

create or replace function public.company_tz(p_company uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select timezone from public.companies where id = p_company), 'UTC')
$$;

-- Wraps template content in a branded, email-client-safe layout.
create or replace function public.email_layout(p_company uuid, p_content text) returns text
language sql stable security definer set search_path = public as $$
  select
    '<div style="background:#f4f6fb;padding:32px 12px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">'
    || '<table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">'
    || '<tr><td style="background:' || c.primary_color || ';padding:20px 28px;color:#ffffff;font-size:18px;font-weight:600">'
    || public.html_escape(c.name) || '</td></tr>'
    || '<tr><td style="padding:28px;font-size:15px;line-height:1.6">' || p_content || '</td></tr>'
    || '<tr><td style="padding:16px 28px;background:#f9fafb;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb">'
    || 'This message was sent by ' || public.html_escape(c.name)
    || coalesce(' &middot; ' || public.html_escape(c.website), '')
    || '. Please do not share secure links contained in this email.</td></tr></table></div>'
  from public.companies c where c.id = p_company
$$;

-- re-define enqueue_email to wrap body with the layout
create or replace function public.enqueue_email(
  p_company uuid, p_template text, p_to_email text, p_to_name text, p_vars jsonb,
  p_dedupe_key text, p_related_table text default null, p_related_id uuid default null,
  p_attachments jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t public.email_templates;
  c public.companies;
  v_vars jsonb;
  v_id uuid;
begin
  if p_to_email is null or p_to_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return null;
  end if;
  select * into c from public.companies where id = p_company;
  select * into t from public.email_templates where company_id = p_company and key = p_template;
  v_vars := jsonb_build_object('company_name', c.name, 'company_email', coalesce(c.email, ''),
                               'company_website', coalesce(c.website, ''), 'recipient_name', coalesce(p_to_name, ''))
            || coalesce(p_vars, '{}'::jsonb);
  insert into public.email_logs (company_id, template_key, to_email, to_name, subject, body_html, attachments,
                                 status, last_error, dedupe_key, related_table, related_id)
  values (
    p_company, p_template, lower(p_to_email), p_to_name,
    coalesce(public.render_template(t.subject, v_vars, false), '[' || p_template || ']'),
    case when t.id is null then '' else public.email_layout(p_company, public.render_template(t.body_html, v_vars, true)) end,
    coalesce(p_attachments, '[]'::jsonb),
    case when t.id is null or not t.is_active then 'skipped' else 'queued' end,
    case when t.id is null then 'Template not found' when not t.is_active then 'Template disabled' end,
    p_dedupe_key, p_related_table, p_related_id
  )
  on conflict (company_id, dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.enqueue_email(uuid, text, text, text, jsonb, text, text, uuid, jsonb) from public, anon, authenticated;

-- ---------- default data for a new company ----------
create or replace function public.seed_company_defaults(p_company uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role uuid;
  v_btn text := 'display:inline-block;background:#2549eb;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600';
begin
  -- roles
  insert into public.roles (company_id, name, description, is_system, is_admin)
  values (p_company, 'Company Admin', 'Full access to everything in this company', true, true);

  insert into public.roles (company_id, name, description, is_system) values
    (p_company, 'HR Manager', 'Manages people, recruitment, attendance, leave and payroll', true) returning id into v_role;
  insert into public.role_permissions (role_id, permission)
    select v_role, key from public.permissions where key not in ('settings.manage','users.manage');

  insert into public.roles (company_id, name, description, is_system) values
    (p_company, 'Recruiter', 'Runs hiring: jobs, candidates, interviews and offers', true) returning id into v_role;
  insert into public.role_permissions (role_id, permission)
    select v_role, unnest(array['dashboard.view','departments.view','requisitions.view','requisitions.manage','jobs.view','jobs.manage',
      'candidates.view','candidates.manage','interviews.view','interviews.manage','offers.view','offers.manage',
      'onboarding.view','onboarding.manage','emails.manage','reports.view']);

  insert into public.roles (company_id, name, description, is_system) values
    (p_company, 'Hiring Manager', 'Raises requisitions, interviews and approves offers', true) returning id into v_role;
  insert into public.role_permissions (role_id, permission)
    select v_role, unnest(array['dashboard.view','departments.view','employees.view','requisitions.view','requisitions.manage',
      'jobs.view','candidates.view','interviews.view','offers.view','offers.approve','leave.approve','reports.view']);

  insert into public.roles (company_id, name, description, is_system) values
    (p_company, 'Payroll Manager', 'Processes payroll and reviews attendance and leave', true) returning id into v_role;
  insert into public.role_permissions (role_id, permission)
    select v_role, unnest(array['dashboard.view','departments.view','employees.view','attendance.view','leave.view',
      'payroll.view','payroll.manage','reports.view']);

  insert into public.roles (company_id, name, description, is_system) values
    (p_company, 'Interviewer', 'Sees assigned interviews and submits feedback', true);
  insert into public.roles (company_id, name, description, is_system) values
    (p_company, 'Employee', 'Self-service: own profile, attendance, leave and payslips', true);

  -- organization
  insert into public.departments (company_id, name, code) values
    (p_company, 'Engineering', 'ENG'), (p_company, 'Human Resources', 'HR'), (p_company, 'Sales', 'SAL'),
    (p_company, 'Finance', 'FIN'), (p_company, 'Operations', 'OPS');
  insert into public.designations (company_id, title, level) values
    (p_company, 'Software Engineer', 'L2'), (p_company, 'Senior Software Engineer', 'L3'),
    (p_company, 'Engineering Manager', 'M1'), (p_company, 'HR Executive', 'L2'),
    (p_company, 'Sales Executive', 'L2'), (p_company, 'Accountant', 'L2');

  -- leave types
  insert into public.leave_types (company_id, name, code, annual_quota, is_paid, carry_forward, color) values
    (p_company, 'Casual Leave', 'CL', 12, true, false, '#2549eb'),
    (p_company, 'Sick Leave', 'SL', 8, true, false, '#e11d48'),
    (p_company, 'Earned Leave', 'EL', 15, true, true, '#059669'),
    (p_company, 'Loss of Pay', 'LOP', 0, false, false, '#64748b');

  -- onboarding checklist
  insert into public.onboarding_task_templates (company_id, title, description, category, due_offset_days, sort_order) values
    (p_company, 'Collect signed offer & ID documents', 'Government ID, address proof, education certificates', 'hr', -3, 1),
    (p_company, 'Background verification', 'Initiate and track background verification', 'hr', -2, 2),
    (p_company, 'Prepare laptop & accounts', 'Laptop, email account and tool access', 'it', -1, 3),
    (p_company, 'Bank & payroll details', 'Collect bank account and tax details', 'finance', 0, 4),
    (p_company, 'Day-1 orientation', 'Company overview, policies and team introductions', 'hr', 0, 5),
    (p_company, 'Assign buddy & 30-day goals', 'Manager sets goals for the first month', 'manager', 3, 6);

  -- email templates
  insert into public.email_templates (company_id, key, name, description, subject, body_html) values
  (p_company, 'application_received', 'Application received', 'Sent to the candidate when an application is submitted',
   'We received your application for {{job_title}}',
   '<p>Hi {{candidate_name}},</p><p>Thank you for applying for the <strong>{{job_title}}</strong> role at {{company_name}}. Our team will review your profile and get back to you soon.</p><p>Best regards,<br/>Talent Acquisition, {{company_name}}</p>'),
  (p_company, 'candidate_shortlisted', 'Candidate shortlisted', 'Sent when a candidate is shortlisted',
   'Good news about your application for {{job_title}}',
   '<p>Hi {{candidate_name}},</p><p>We are pleased to let you know that you have been <strong>shortlisted</strong> for the <strong>{{job_title}}</strong> role. We will reach out shortly with interview details.</p><p>Best regards,<br/>{{company_name}}</p>'),
  (p_company, 'application_on_hold', 'Application on hold', 'Sent when an application is put on hold',
   'Update on your application for {{job_title}}',
   '<p>Hi {{candidate_name}},</p><p>Your application for <strong>{{job_title}}</strong> is currently on hold. We will contact you as soon as there is an update.</p><p>Thank you for your patience,<br/>{{company_name}}</p>'),
  (p_company, 'application_rejected', 'Application unsuccessful', 'Sent when a candidate is rejected',
   'Your application for {{job_title}}',
   '<p>Hi {{candidate_name}},</p><p>Thank you for your interest in the <strong>{{job_title}}</strong> role. After careful consideration we have decided to move forward with other candidates. We will keep your profile for future opportunities.</p><p>We wish you the very best,<br/>{{company_name}}</p>'),
  (p_company, 'candidate_selected', 'Candidate selected', 'Sent when a candidate is selected after interviews',
   'Congratulations — you have been selected for {{job_title}}',
   '<p>Hi {{candidate_name}},</p><p>Congratulations! You have been <strong>selected</strong> for the <strong>{{job_title}}</strong> role. Our HR team is preparing your offer letter and will share it shortly.</p><p>Best regards,<br/>{{company_name}}</p>'),
  (p_company, 'interview_scheduled', 'Interview scheduled', 'Sent to the candidate when an interview is scheduled',
   'Interview scheduled: {{job_title}} — {{interview_date}}',
   '<p>Hi {{candidate_name}},</p><p>Your interview for <strong>{{job_title}}</strong> has been scheduled.</p><table style="border-collapse:collapse;margin:12px 0"><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Round</td><td>{{round_name}}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Date</td><td>{{interview_date}}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Time</td><td>{{interview_time}} ({{timezone}})</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Duration</td><td>{{duration}} minutes</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Mode</td><td>{{interview_type}}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Location / link</td><td>{{location}} {{meeting_link}}</td></tr></table><p>Please reply to this email if you need to reschedule.</p><p>Best of luck,<br/>{{company_name}}</p>'),
  (p_company, 'interview_rescheduled', 'Interview rescheduled', 'Sent when an interview time changes',
   'Interview rescheduled: {{job_title}} — {{interview_date}}',
   '<p>Hi {{candidate_name}},</p><p>Your <strong>{{round_name}}</strong> interview for <strong>{{job_title}}</strong> has been rescheduled to <strong>{{interview_date}} at {{interview_time}} ({{timezone}})</strong>.</p><p>Mode: {{interview_type}} {{location}} {{meeting_link}}</p><p>Regards,<br/>{{company_name}}</p>'),
  (p_company, 'interview_cancelled', 'Interview cancelled', 'Sent when an interview is cancelled',
   'Interview cancelled: {{job_title}}',
   '<p>Hi {{candidate_name}},</p><p>Your <strong>{{round_name}}</strong> interview for <strong>{{job_title}}</strong> scheduled on {{interview_date}} has been cancelled. {{reason}}</p><p>We will be in touch about next steps.</p><p>Regards,<br/>{{company_name}}</p>'),
  (p_company, 'interviewer_assigned', 'Interviewer assigned', 'Sent to panelists when they are added to an interview',
   'You are interviewing {{candidate_name}} on {{interview_date}}',
   '<p>Hi {{recipient_name}},</p><p>You have been added to the interview panel for <strong>{{candidate_name}}</strong> ({{job_title}}).</p><p><strong>{{round_name}}</strong> &middot; {{interview_date}} at {{interview_time}} ({{timezone}}) &middot; {{duration}} min &middot; {{interview_type}}</p><p>Please submit your feedback in the HRMS after the interview.</p>'),
  (p_company, 'offer_letter', 'Offer letter', 'Sent to the candidate with the offer PDF and secure acceptance link',
   'Your offer from {{company_name}} — {{job_title}}',
   '<p>Hi {{candidate_name}},</p><p>We are delighted to offer you the position of <strong>{{job_title}}</strong> at {{company_name}} with an annual CTC of <strong>{{ctc}}</strong> and a proposed joining date of <strong>{{joining_date}}</strong>.</p><p>Your offer letter is attached. Please review and respond using the secure link below before <strong>{{expiry_date}}</strong>.</p><p style="margin:24px 0"><a href="{{offer_link}}" style="' || v_btn || '">Review &amp; respond to offer</a></p><p style="color:#6b7280;font-size:13px">This link is personal to you. Do not forward it.</p><p>Warm regards,<br/>{{company_name}}</p>'),
  (p_company, 'offer_accepted', 'Offer accepted confirmation', 'Sent to the candidate after accepting the offer',
   'Welcome aboard! Your acceptance is confirmed',
   '<p>Hi {{candidate_name}},</p><p>Thank you for accepting our offer for <strong>{{job_title}}</strong>. We are excited to have you join us on <strong>{{joining_date}}</strong>. Our HR team will contact you with onboarding details.</p><p>Warm regards,<br/>{{company_name}}</p>'),
  (p_company, 'joining_confirmation', 'Joining confirmation', 'Sent when HR confirms the joining date',
   'Your joining details — {{joining_date}}',
   '<p>Hi {{candidate_name}},</p><p>Your joining date is confirmed for <strong>{{joining_date}}</strong>. Please report to <strong>{{work_location}}</strong> at <strong>{{reporting_time}}</strong> with your original documents.</p><p>See you soon!<br/>{{company_name}}</p>'),
  (p_company, 'welcome_employee', 'Welcome employee', 'Sent when onboarding completes and the employee record is created',
   'Welcome to {{company_name}}, {{employee_name}}!',
   '<p>Hi {{employee_name}},</p><p>Welcome to the team! Your employee code is <strong>{{employee_code}}</strong>.</p><p>Create your HRMS account with this email address to access attendance, leave and payslips:</p><p style="margin:24px 0"><a href="{{login_link}}" style="' || v_btn || '">Activate your account</a></p><p>Cheers,<br/>{{company_name}}</p>'),
  (p_company, 'user_invitation', 'User invitation', 'Sent when a user is invited to the HRMS',
   'You have been invited to {{company_name}} on TalentFlow HRMS',
   '<p>Hi,</p><p>You have been invited to join <strong>{{company_name}}</strong> as <strong>{{role_name}}</strong>.</p><p style="margin:24px 0"><a href="{{invite_link}}" style="' || v_btn || '">Accept invitation</a></p><p style="color:#6b7280;font-size:13px">Sign up or sign in with this email address to accept. This invitation expires in 14 days.</p>'),
  (p_company, 'leave_decision', 'Leave decision', 'Sent to an employee when a leave request is approved or rejected',
   'Your leave request has been {{decision}}',
   '<p>Hi {{employee_name}},</p><p>Your <strong>{{leave_type}}</strong> request from <strong>{{start_date}}</strong> to <strong>{{end_date}}</strong> ({{days}} day(s)) has been <strong>{{decision}}</strong>.</p><p>{{note}}</p>'),
  (p_company, 'payslip_available', 'Payslip available', 'Sent to employees when payroll is processed',
   'Your payslip for {{period}} is available',
   '<p>Hi {{employee_name}},</p><p>Your payslip for <strong>{{period}}</strong> is now available in the HRMS. Net pay: <strong>{{net_pay}}</strong>.</p>');
end $$;
revoke execute on function public.seed_company_defaults(uuid) from public, anon, authenticated;

-- ---------- self-serve company creation ----------
create or replace function public.create_company(p_name text, p_slug text, p_email text default null, p_country text default 'India')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_role uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if char_length(coalesce(trim(p_name), '')) < 2 then raise exception 'Company name is required'; end if;
  if p_slug !~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$' then
    raise exception 'URL slug must be 3-50 characters: lowercase letters, numbers and hyphens';
  end if;
  if exists (select 1 from public.companies where slug = p_slug) then
    raise exception 'The URL slug "%" is already taken', p_slug using errcode = '23505';
  end if;
  -- simple abuse guard: max 5 companies created per user per day
  if (select count(*) from public.companies where created_by = auth.uid() and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Too many companies created today. Please try again tomorrow.';
  end if;

  insert into public.companies (name, slug, email, country, created_by, status, plan)
  values (trim(p_name), p_slug, nullif(trim(coalesce(p_email, '')), ''), coalesce(p_country, 'India'), auth.uid(), 'trial', 'trial')
  returning id into v_id;
  perform public.seed_company_defaults(v_id);
  select id into v_role from public.roles where company_id = v_id and is_admin limit 1;
  insert into public.company_members (company_id, user_id, role_id) values (v_id, auth.uid(), v_role);
  update public.profiles set last_company_id = v_id where id = auth.uid();
  return v_id;
end $$;

-- companies the current user belongs to
create or replace function public.my_companies()
returns table (id uuid, name text, slug text, logo_url text, primary_color text, status text, role_name text, is_admin boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.slug, c.logo_url, c.primary_color, c.status, r.name, r.is_admin
  from public.company_members m
  join public.companies c on c.id = m.company_id
  join public.roles r on r.id = m.role_id
  where m.user_id = auth.uid() and m.status = 'active'
  union
  select c.id, c.name, c.slug, c.logo_url, c.primary_color, c.status, 'Platform Admin', true
  from public.companies c
  where public.is_super_admin()
    and not exists (select 1 from public.company_members m where m.company_id = c.id and m.user_id = auth.uid())
  order by 2
$$;

-- ---------- invitations ----------
create or replace function public.invite_member(p_company uuid, p_email text, p_role uuid, p_employee uuid default null, p_base_url text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_user uuid;
  v_inv uuid;
  v_role_name text;
begin
  if not public.has_permission(p_company, 'users.manage') then
    raise exception 'You do not have permission to invite users' using errcode = '42501';
  end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  select name into v_role_name from public.roles where id = p_role and company_id = p_company;
  if v_role_name is null then raise exception 'Invalid role'; end if;
  if p_employee is not null and not exists (select 1 from public.employees where id = p_employee and company_id = p_company) then
    raise exception 'Invalid employee';
  end if;

  select id into v_user from public.profiles where lower(email) = v_email;
  if v_user is not null then
    if exists (select 1 from public.company_members where company_id = p_company and user_id = v_user) then
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

-- called after sign-in: converts pending invitations for the user's verified email into memberships
create or replace function public.accept_my_invitations() returns integer
language plpgsql security definer set search_path = public as $$
declare v_email text; v_count integer := 0; r record;
begin
  if auth.uid() is null then return 0; end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  for r in select * from public.company_invitations
           where lower(email) = v_email and status = 'pending' and expires_at > now() loop
    insert into public.company_members (company_id, user_id, role_id, employee_id, invited_by)
    values (r.company_id, auth.uid(), r.role_id, r.employee_id, r.invited_by)
    on conflict (company_id, user_id) do update set status = 'active', role_id = excluded.role_id,
      employee_id = coalesce(excluded.employee_id, public.company_members.employee_id);
    if r.employee_id is not null then
      update public.employees set user_id = auth.uid() where id = r.employee_id;
    end if;
    update public.company_invitations set status = 'accepted', accepted_at = now() where id = r.id;
    v_count := v_count + 1;
  end loop;
  -- employees whose work email matches and who have no login yet get linked automatically
  for r in select e.id, e.company_id from public.employees e
           where lower(e.email) = v_email and e.user_id is null and e.status not in ('inactive','terminated') loop
    if not exists (select 1 from public.company_members where company_id = r.company_id and user_id = auth.uid()) then
      insert into public.company_members (company_id, user_id, role_id, employee_id)
      select r.company_id, auth.uid(), id, r.id from public.roles where company_id = r.company_id and name = 'Employee' limit 1;
      v_count := v_count + 1;
    else
      update public.company_members set employee_id = coalesce(employee_id, r.id) where company_id = r.company_id and user_id = auth.uid();
    end if;
    update public.employees set user_id = auth.uid() where id = r.id;
  end loop;
  return v_count;
end $$;

-- ---------- super admin ----------
create or replace function public.admin_create_company(p_name text, p_slug text, p_admin_email text,
  p_plan text default 'starter', p_max_employees integer default 100, p_base_url text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_role uuid; v_user uuid; v_email text := lower(trim(p_admin_email));
begin
  if not public.is_super_admin() then raise exception 'Platform administrator access required' using errcode = '42501'; end if;
  if p_slug !~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$' then raise exception 'Invalid URL slug'; end if;
  if exists (select 1 from public.companies where slug = p_slug) then raise exception 'The URL slug "%" is already taken', p_slug; end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid admin email'; end if;

  insert into public.companies (name, slug, email, plan, max_employees, status, created_by)
  values (trim(p_name), p_slug, v_email, p_plan, p_max_employees, 'active', auth.uid()) returning id into v_id;
  perform public.seed_company_defaults(v_id);
  select id into v_role from public.roles where company_id = v_id and is_admin limit 1;
  select id into v_user from public.profiles where lower(email) = v_email;
  if v_user is not null then
    insert into public.company_members (company_id, user_id, role_id, invited_by) values (v_id, v_user, v_role, auth.uid());
  else
    insert into public.company_invitations (company_id, email, role_id) values (v_id, v_email, v_role);
    perform public.enqueue_email(v_id, 'user_invitation', v_email, null,
      jsonb_build_object('role_name', 'Company Admin', 'invite_link', coalesce(p_base_url, '') || '/signup?email=' || v_email),
      'invite:admin:' || v_id::text, 'companies', v_id);
  end if;
  return v_id;
end $$;

create or replace function public.admin_update_company(p_company uuid, p_status text, p_plan text, p_max_employees integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Platform administrator access required' using errcode = '42501'; end if;
  update public.companies set status = p_status, plan = p_plan, max_employees = p_max_employees where id = p_company;
  if not found then raise exception 'Company not found'; end if;
end $$;

create or replace function public.admin_platform_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Platform administrator access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'companies', (select count(*) from public.companies),
    'active_companies', (select count(*) from public.companies where status = 'active'),
    'trial_companies', (select count(*) from public.companies where status = 'trial'),
    'suspended_companies', (select count(*) from public.companies where status = 'suspended'),
    'users', (select count(*) from public.profiles),
    'employees', (select count(*) from public.employees where status not in ('inactive','terminated')),
    'applications_30d', (select count(*) from public.applications where applied_at > now() - interval '30 days'),
    'emails_30d', (select count(*) from public.email_logs where created_at > now() - interval '30 days'),
    'companies_by_plan', (select coalesce(jsonb_agg(jsonb_build_object('plan', plan, 'count', n)), '[]') from
                           (select plan, count(*) n from public.companies group by plan) x),
    'signups_by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', m, 'count', n) order by m), '[]') from
                          (select to_char(date_trunc('month', created_at), 'YYYY-MM') m, count(*) n
                           from public.companies where created_at > now() - interval '12 months' group by 1) y)
  );
end $$;
