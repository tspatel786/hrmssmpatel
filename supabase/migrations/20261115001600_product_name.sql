-- =====================================================================
-- 1600  PRODUCT NAME IN EMAILS (rebrand to S.M.PATEL HRMS)
-- The default "user_invitation" subject still named the old product ("… on TalentFlow HRMS").
-- A. seed_company_defaults (new companies) is re-created unchanged except for that subject.
-- B. Existing companies: only templates whose subject is still the untouched old default are updated;
--    a subject a company has customised is left as it is.
-- No table is dropped, no data is deleted, no policy is changed.
-- =====================================================================

-- ---------- A. new companies ----------
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
   'You have been invited to {{company_name}} on S.M.PATEL HRMS',
   '<p>Hi,</p><p>You have been invited to join <strong>{{company_name}}</strong> as <strong>{{role_name}}</strong>.</p><p style="margin:24px 0"><a href="{{invite_link}}" style="' || v_btn || '">Accept invitation</a></p><p style="color:#6b7280;font-size:13px">Sign up or sign in with this email address to accept. This invitation expires in 14 days.</p>'),
  (p_company, 'leave_decision', 'Leave decision', 'Sent to an employee when a leave request is approved or rejected',
   'Your leave request has been {{decision}}',
   '<p>Hi {{employee_name}},</p><p>Your <strong>{{leave_type}}</strong> request from <strong>{{start_date}}</strong> to <strong>{{end_date}}</strong> ({{days}} day(s)) has been <strong>{{decision}}</strong>.</p><p>{{note}}</p>'),
  (p_company, 'payslip_available', 'Payslip available', 'Sent to employees when payroll is processed',
   'Your payslip for {{period}} is available',
   '<p>Hi {{employee_name}},</p><p>Your payslip for <strong>{{period}}</strong> is now available in the HRMS. Net pay: <strong>{{net_pay}}</strong>.</p>');
end $$;
revoke execute on function public.seed_company_defaults(uuid) from public, anon, authenticated;

-- ---------- B. existing companies (untouched defaults only) ----------
update public.email_templates
   set subject = 'You have been invited to {{company_name}} on S.M.PATEL HRMS'
 where key = 'user_invitation'
   and subject = 'You have been invited to {{company_name}} on TalentFlow HRMS';
