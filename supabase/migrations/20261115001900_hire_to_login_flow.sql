-- =====================================================================
-- 1900  HIRE-TO-LOGIN FLOW
-- requisition -> approval -> job on careers page + INTERNAL OPENINGS -> application / internal application / referral
-- -> interview -> offer -> DOCUMENT VERIFICATION -> onboarding -> APPOINTMENT LETTER -> EMPLOYEE ID + SET-PASSWORD LINK
-- -> login with Employee ID or email. Every operation emails the people involved.
--
-- A. platform_settings.app_url (absolute links in emails) and company letterhead images
-- B. email templates for the new steps (all companies + new companies)
-- C. every in-app notification is also emailed, unless the same operation already emailed that person
-- D. requisition submitted / approved / rejected notifications (were silent)
-- E. internal openings: jobs.internal_visible, alert to all members on publish, internal apply, referrals
-- F. onboarding document verification (candidate uploads via a secret link, HR verifies; completion requires it)
-- G. employee login: activation token emailed with the Employee ID; edge function creates the account
-- H. appointment letter: stored in the employee's documents and emailed as a PDF attachment
-- No table is dropped, no data is deleted, no policy is loosened.
-- =====================================================================

-- ---------- A. settings ----------
alter table public.platform_settings add column if not exists app_url text;
create or replace function public.app_url() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(rtrim((select app_url from public.platform_settings where id), '/'), '')
$$;
revoke execute on function public.app_url() from public, anon, authenticated;

alter table public.companies add column if not exists letterhead_header_url text;
alter table public.companies add column if not exists letterhead_footer_url text;

-- ---------- B. templates ----------
create or replace function public.seed_flow_templates(p_company uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_btn text := 'display:inline-block;background:#d4af37;color:#050505;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600';
begin
  insert into public.email_templates (company_id, key, name, description, subject, body_html) values
  (p_company, 'notification', 'Activity notification', 'Emailed copy of an in-app notification (approvals, requests, decisions, new openings…)',
   '{{title}}',
   '<p>Hi {{recipient_name}},</p><p><strong>{{title}}</strong></p><p>{{body}}</p><p style="margin:24px 0"><a href="{{link_url}}" style="' || v_btn || '">Open in HRMS</a></p>'),
  (p_company, 'documents_requested', 'Joining documents requested', 'Sent to a new joiner after accepting the offer, with the secure upload link',
   'Action needed: upload your joining documents — {{company_name}}',
   '<p>Hi {{candidate_name}},</p><p>Welcome! To complete your joining for <strong>{{job_title}}</strong> (joining date <strong>{{joining_date}}</strong>), please upload the following documents:</p><p>{{document_list}}</p><p style="margin:24px 0"><a href="{{upload_link}}" style="' || v_btn || '">Upload documents</a></p><p style="color:#6b7280;font-size:13px">This link is personal to you. Do not forward it.</p>'),
  (p_company, 'document_rejected', 'Joining document needs re-upload', 'Sent when HR rejects an uploaded joining document',
   'Please re-upload: {{document_name}}',
   '<p>Hi {{candidate_name}},</p><p>Your <strong>{{document_name}}</strong> could not be verified.</p><p>Reason: {{reason}}</p><p style="margin:24px 0"><a href="{{upload_link}}" style="' || v_btn || '">Upload again</a></p>'),
  (p_company, 'documents_verified', 'Joining documents verified', 'Sent when all required joining documents are verified',
   'Your documents are verified — {{company_name}}',
   '<p>Hi {{candidate_name}},</p><p>All your joining documents have been verified. We look forward to welcoming you on <strong>{{joining_date}}</strong>.</p>'),
  (p_company, 'employee_credentials', 'Employee ID and login', 'Sent when onboarding completes: Employee ID and a one-time link to set the password',
   'Welcome to {{company_name}} — your Employee ID {{employee_code}}',
   '<p>Hi {{employee_name}},</p><p>Welcome to the team! Your HRMS account is ready.</p><table style="border-collapse:collapse;margin:12px 0"><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Employee ID</td><td><strong>{{employee_code}}</strong></td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Joining date</td><td>{{joining_date}}</td></tr></table><p>Set your password with the button below, then sign in with your Employee ID (or this email address).</p><p style="margin:24px 0"><a href="{{activation_link}}" style="' || v_btn || '">Set your password</a></p><p style="color:#6b7280;font-size:13px">This link can be used once and expires on {{expires_on}}. If it expires, ask HR to send a new one.</p>'),
  (p_company, 'appointment_letter', 'Appointment letter', 'Sent with the appointment letter PDF when an employee joins',
   'Your appointment letter — {{company_name}}',
   '<p>Hi {{employee_name}},</p><p>Please find attached your appointment letter for the position of <strong>{{designation}}</strong>, effective <strong>{{joining_date}}</strong>.</p><p>Your Employee ID is <strong>{{employee_code}}</strong>. A copy is also available under My profile → Documents in the HRMS.</p>')
  on conflict (company_id, key) do nothing;
end $$;
revoke execute on function public.seed_flow_templates(uuid) from public, anon, authenticated;
select public.seed_flow_templates(id) from public.companies;

create or replace function public.on_company_created_flow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_flow_templates(new.id);
  return new;
end $$;
drop trigger if exists trg_company_created_flow on public.companies;
create trigger trg_company_created_flow after insert on public.companies
  for each row execute function public.on_company_created_flow();

-- ---------- C. notification -> email ----------
-- Deferred to commit, so it sees every email the same operation queued: if that person already got a dedicated email
-- (leave decision, payslip, interviewer assigned…) in this transaction, the generic copy is skipped.
create or replace function public.email_notification() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_email text; v_name text;
begin
  select p.email, p.full_name into v_email, v_name from public.profiles p where p.id = new.user_id;
  if v_email is null then return null; end if;
  if exists (select 1 from public.email_logs l where l.company_id = new.company_id and lower(l.to_email) = lower(v_email)
             and l.created_at = now()) then
    return null;
  end if;
  perform public.enqueue_email(new.company_id, 'notification', v_email, v_name,
    jsonb_build_object('title', new.title, 'body', coalesce(new.body, ''),
      'link_url', public.app_url() || coalesce(new.link, '/app')),
    'notification:' || new.id, 'notifications', new.id);
  return null;
end $$;
drop trigger if exists trg_email_notification on public.notifications;
create constraint trigger trg_email_notification after insert on public.notifications
  deferrable initially deferred for each row execute function public.email_notification();

-- ---------- D. requisitions ----------
create or replace function public.on_requisition_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if new.status = 'pending_approval' then
    perform public.notify_permission(new.company_id, 'requisitions.approve', 'approval', 'Requisition awaiting approval',
      new.title || ' (' || new.headcount || ' position(s)) needs your approval', '/app/recruitment/requisitions');
  elsif new.status in ('approved', 'rejected') and new.requested_by is not null then
    perform public.notify_user(new.company_id, new.requested_by, 'approval',
      'Requisition ' || new.status || ': ' || new.title,
      coalesce('Note: ' || nullif(new.decision_note, ''), case when new.status = 'approved'
        then 'You can now create the job opening.' else 'Update and resubmit it if needed.' end),
      '/app/recruitment/requisitions');
  end if;
  return new;
end $$;
drop trigger if exists trg_requisition_status on public.job_requisitions;
create trigger trg_requisition_status after insert or update of status on public.job_requisitions
  for each row execute function public.on_requisition_status();

-- ---------- E. internal openings ----------
alter table public.jobs add column if not exists internal_visible boolean not null default true;
alter table public.applications add column if not exists referred_by uuid references public.employees(id) on delete set null;

do $$
declare v_con text;
begin
  select conname into v_con from pg_constraint
  where conrelid = 'public.candidates'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%source%';
  if v_con is not null then execute format('alter table public.candidates drop constraint %I', v_con); end if;
  alter table public.candidates add constraint candidates_source_check
    check (source in ('careers','internal','referral','linkedin','agency','direct','job_board','other'));
end $$;

create or replace function public.on_job_published() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'published' and new.internal_visible
     and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    insert into public.notifications (company_id, user_id, type, title, body, link)
    select new.company_id, m.user_id, 'job', 'New internal opening: ' || new.title,
      coalesce(new.location || ' · ', '') || 'Apply internally or refer someone you know.', '/app/openings'
    from public.company_members m
    where m.company_id = new.company_id and m.status = 'active' and m.user_id is distinct from auth.uid();
  end if;
  return new;
end $$;
drop trigger if exists trg_job_published on public.jobs;
create trigger trg_job_published after insert or update of status on public.jobs
  for each row execute function public.on_job_published();

create or replace function public.internal_openings(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company);
begin
  if not public.is_member(p_company) then raise exception 'Not a member of this company' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', j.id, 'title', j.title, 'location', j.location, 'employment_type', j.employment_type,
      'work_mode', j.work_mode, 'openings', j.openings, 'closing_date', j.closing_date, 'description', j.description,
      'department', d.name, 'published_at', j.published_at,
      'applied', exists (select 1 from public.applications a join public.candidates c on c.id = a.candidate_id
                         join public.employees e on e.id = v_emp
                         where a.job_id = j.id and lower(c.email) = lower(e.email)),
      'my_referrals', (select count(*) from public.applications a where a.job_id = j.id and a.referred_by = v_emp))
      order by j.published_at desc nulls last)
    from public.jobs j left join public.departments d on d.id = j.department_id
    where j.company_id = p_company and j.status = 'published' and j.internal_visible
      and (j.closing_date is null or j.closing_date >= current_date)), '[]'::jsonb);
end $$;
revoke execute on function public.internal_openings(uuid) from public, anon;
grant execute on function public.internal_openings(uuid) to authenticated;

create or replace function public.internal_job(p_job uuid) returns public.jobs
language plpgsql stable security definer set search_path = public as $$
declare j public.jobs;
begin
  select * into j from public.jobs where id = p_job and status = 'published' and internal_visible
    and (closing_date is null or closing_date >= current_date);
  if j.id is null or not public.is_member(j.company_id) then raise exception 'This opening is no longer available'; end if;
  return j;
end $$;
revoke execute on function public.internal_job(uuid) from public, anon, authenticated;

create or replace function public.internal_apply(p_job uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare j public.jobs; e public.employees; v_cand uuid; v_app uuid;
begin
  j := public.internal_job(p_job);
  select * into e from public.employees where id = public.my_employee_id(j.company_id);
  if e.id is null then raise exception 'Only employees can apply internally'; end if;
  if char_length(coalesce(p_note, '')) > 3000 then raise exception 'Note is too long (max 3000 characters)'; end if;
  select id into v_cand from public.candidates where company_id = j.company_id and lower(email) = lower(e.email);
  if v_cand is null then
    insert into public.candidates (company_id, first_name, last_name, email, phone, current_company, current_title, source)
    values (j.company_id, e.first_name, coalesce(e.last_name, ''), lower(e.email), coalesce(nullif(e.phone, ''), '0000000'),
      (select name from public.companies where id = j.company_id),
      (select title from public.designations where id = e.designation_id), 'internal')
    returning id into v_cand;
  elsif exists (select 1 from public.applications where job_id = j.id and candidate_id = v_cand) then
    raise exception 'You have already applied for this opening' using errcode = '23505';
  end if;
  insert into public.applications (company_id, job_id, candidate_id, cover_letter, source)
  values (j.company_id, j.id, v_cand, nullif(trim(coalesce(p_note, '')), ''), 'internal')
  returning id into v_app;
  return v_app;
end $$;
revoke execute on function public.internal_apply(uuid, text) from public, anon;
grant execute on function public.internal_apply(uuid, text) to authenticated;

-- referral resumes: resumes/<company>/referrals/<uuid>/<file>, uploaded by active members of that company
create or replace function public.referral_upload_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select split_part(p_name, '/', 2) = 'referrals'
     and public.try_uuid(split_part(p_name, '/', 3)) is not null
     and p_name not like '%..%'
     and public.is_member(public.storage_company(p_name))
$$;
grant execute on function public.referral_upload_allowed(text) to authenticated;
drop policy if exists "members upload referral resumes" on storage.objects;
create policy "members upload referral resumes" on storage.objects for insert to authenticated
  with check (bucket_id = 'resumes' and public.referral_upload_allowed(name));

create or replace function public.refer_candidate(p_job uuid, p_data jsonb, p_resume jsonb default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  j public.jobs; v_emp uuid; v_cand uuid; v_app uuid; v_path text;
  v_email text := lower(trim(coalesce(p_data ->> 'email', '')));
  v_first text := trim(coalesce(p_data ->> 'first_name', ''));
  v_last text := trim(coalesce(p_data ->> 'last_name', ''));
  v_phone text := trim(coalesce(p_data ->> 'phone', ''));
  v_note text := nullif(trim(coalesce(p_data ->> 'note', '')), '');
begin
  j := public.internal_job(p_job);
  v_emp := public.my_employee_id(j.company_id);
  if v_emp is null then raise exception 'Only employees can refer candidates'; end if;
  if char_length(v_first) < 1 or char_length(v_first) > 60 then raise exception 'First name is required (max 60 characters)'; end if;
  if char_length(v_last) > 60 then raise exception 'Last name is too long'; end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then raise exception 'Enter a valid email address'; end if;
  if v_phone !~ '^[+0-9 ()-]{7,20}$' then raise exception 'Enter a valid phone number'; end if;
  if char_length(coalesce(v_note, '')) > 3000 then raise exception 'Note is too long (max 3000 characters)'; end if;
  if exists (select 1 from public.employees where company_id = j.company_id and lower(email) = v_email) then
    raise exception 'This person is already an employee — they can apply internally';
  end if;
  perform public.check_rate_limit('refer:user', auth.uid()::text, 20, interval '1 day');

  if p_resume is not null and nullif(p_resume ->> 'path', '') is not null then
    v_path := p_resume ->> 'path';
    if v_path not like j.company_id::text || '/referrals/%' or v_path like '%..%' then raise exception 'Invalid resume upload'; end if;
    if not exists (select 1 from storage.objects where bucket_id = 'resumes' and name = v_path) then
      raise exception 'Resume upload not found. Please upload again.';
    end if;
  end if;

  select id into v_cand from public.candidates where company_id = j.company_id and lower(email) = v_email;
  if v_cand is null then
    insert into public.candidates (company_id, first_name, last_name, email, phone, source)
    values (j.company_id, v_first, v_last, v_email, v_phone, 'referral') returning id into v_cand;
  elsif exists (select 1 from public.applications where job_id = j.id and candidate_id = v_cand) then
    raise exception 'This candidate has already applied for this opening' using errcode = '23505';
  end if;
  insert into public.applications (company_id, job_id, candidate_id, cover_letter, source, referred_by)
  values (j.company_id, j.id, v_cand, v_note, 'referral', v_emp) returning id into v_app;
  if v_path is not null then
    insert into public.candidate_documents (company_id, candidate_id, application_id, doc_type, file_name, storage_bucket,
      storage_path, mime_type, size_bytes, uploaded_by)
    values (j.company_id, v_cand, v_app, 'resume', left(coalesce(p_resume ->> 'name', 'resume'), 200), 'resumes', v_path,
      p_resume ->> 'mime', nullif(p_resume ->> 'size', '')::bigint, auth.uid());
  end if;
  perform public.notify_user(j.company_id, auth.uid(), 'application', 'Referral submitted: ' || v_first || ' ' || v_last,
    'Thank you for referring a candidate for ' || j.title || '. HR will keep you posted.', '/app/openings');
  return v_app;
end $$;
revoke execute on function public.refer_candidate(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.refer_candidate(uuid, jsonb, jsonb) to authenticated;

-- ---------- F. onboarding document verification ----------
alter table public.onboardings add column if not exists documents_token uuid not null default gen_random_uuid();
create unique index if not exists onboardings_documents_token_idx on public.onboardings (documents_token);

create table if not exists public.onboarding_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  onboarding_id uuid not null references public.onboardings(id) on delete cascade,
  label text not null check (char_length(label) between 2 and 120),
  required boolean not null default true,
  status text not null default 'pending' check (status in ('pending','submitted','verified','rejected')),
  storage_path text,
  file_name text,
  mime_type text,
  size_bytes bigint check (size_bytes between 0 and 10485760),
  note text check (char_length(note) <= 500),
  sort_order integer not null default 0,
  submitted_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check (storage_path is null or storage_path like company_id::text || '/onboarding/' || onboarding_id::text || '/%')
);
create index if not exists onboarding_documents_idx on public.onboarding_documents (onboarding_id, sort_order);
alter table public.onboarding_documents enable row level security;
drop policy if exists "read onboarding documents" on public.onboarding_documents;
create policy "read onboarding documents" on public.onboarding_documents for select to authenticated
  using (public.has_permission(company_id, 'onboarding.view'));
-- HR may add or remove requested documents; status changes go through verify_onboarding_document()
drop policy if exists "onboarding managers add documents" on public.onboarding_documents;
create policy "onboarding managers add documents" on public.onboarding_documents for insert to authenticated
  with check (public.has_permission(company_id, 'onboarding.manage') and status = 'pending' and storage_path is null
              and exists (select 1 from public.onboardings o where o.id = onboarding_id and o.company_id = onboarding_documents.company_id));
drop policy if exists "onboarding managers remove documents" on public.onboarding_documents;
create policy "onboarding managers remove documents" on public.onboarding_documents for delete to authenticated
  using (public.has_permission(company_id, 'onboarding.manage') and status <> 'verified');
grant select, insert, delete on public.onboarding_documents to authenticated;

-- storage: documents/<company>/onboarding/<onboarding_id>/<uuid>/<file>
create or replace function public.onboarding_upload_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select split_part(p_name, '/', 2) = 'onboarding'
     and public.try_uuid(split_part(p_name, '/', 4)) is not null
     and p_name not like '%..%'
     and exists (select 1 from public.onboardings o where o.id = public.try_uuid(split_part(p_name, '/', 3))
                 and o.company_id = public.storage_company(p_name) and o.status in ('pending', 'in_progress'))
$$;
grant execute on function public.onboarding_upload_allowed(text) to anon, authenticated;
drop policy if exists "joiners upload onboarding documents" on storage.objects;
create policy "joiners upload onboarding documents" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'documents' and public.onboarding_upload_allowed(name));

create or replace function public.can_access_document(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select case split_part(p_name, '/', 2)
    when 'offers' then public.has_permission(public.storage_company(p_name), case when p_write then 'offers.manage' else 'offers.view' end)
    when 'employees' then public.has_permission(public.storage_company(p_name), case when p_write then 'employees.manage' else 'employees.view' end)
                          or (not p_write and public.try_uuid(split_part(p_name, '/', 3)) = public.my_employee_id(public.storage_company(p_name)))
    when 'candidates' then public.has_permission(public.storage_company(p_name), case when p_write then 'candidates.manage' else 'candidates.view' end)
    when 'onboarding' then public.has_permission(public.storage_company(p_name), case when p_write then 'onboarding.manage' else 'onboarding.view' end)
    else false end
$$;

create or replace function public.onboarding_doc_vars(p_onboarding uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'candidate_name', trim(c.first_name || ' ' || coalesce(c.last_name, '')), 'candidate_email', c.email,
    'job_title', j.title, 'joining_date', public.fmt_date(o.joining_date),
    'upload_link', public.app_url() || '/joining-documents/' || o.documents_token,
    'document_list', coalesce((select string_agg('• ' || d.label || case when d.required then '' else ' (optional)' end, chr(10) order by d.sort_order)
                               from public.onboarding_documents d where d.onboarding_id = o.id), ''))
  from public.onboardings o
  join public.candidates c on c.id = o.candidate_id
  join public.applications a on a.id = o.application_id
  join public.jobs j on j.id = a.job_id
  where o.id = p_onboarding
$$;
revoke execute on function public.onboarding_doc_vars(uuid) from public, anon, authenticated;

create or replace function public.on_onboarding_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  insert into public.onboarding_documents (company_id, onboarding_id, label, required, sort_order) values
    (new.company_id, new.id, 'Aadhaar card', true, 1),
    (new.company_id, new.id, 'PAN card', true, 2),
    (new.company_id, new.id, 'Highest education certificate', true, 3),
    (new.company_id, new.id, 'Passport-size photograph', true, 4),
    (new.company_id, new.id, 'Bank proof (cancelled cheque or passbook)', true, 5),
    (new.company_id, new.id, 'Previous employment relieving letter', false, 6);
  v := public.onboarding_doc_vars(new.id);
  perform public.enqueue_email(new.company_id, 'documents_requested', v ->> 'candidate_email', v ->> 'candidate_name', v,
    'onboarding:' || new.id || ':documents', 'onboardings', new.id);
  return new;
end $$;
drop trigger if exists trg_onboarding_created on public.onboardings;
create trigger trg_onboarding_created after insert on public.onboardings
  for each row execute function public.on_onboarding_created();

-- onboardings that existed before this migration get the same list (no email: HR can send the link from the page)
insert into public.onboarding_documents (company_id, onboarding_id, label, required, sort_order)
select o.company_id, o.id, d.label, d.required, d.sort_order
from public.onboardings o
cross join (values ('Aadhaar card', true, 1), ('PAN card', true, 2), ('Highest education certificate', true, 3),
                   ('Passport-size photograph', true, 4), ('Bank proof (cancelled cheque or passbook)', true, 5),
                   ('Previous employment relieving letter', false, 6)) d(label, required, sort_order)
where o.status in ('pending', 'in_progress')
  and not exists (select 1 from public.onboarding_documents x where x.onboarding_id = o.id);

create or replace function public.resend_onboarding_documents_link(p_onboarding uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.onboardings; v jsonb;
begin
  select * into o from public.onboardings where id = p_onboarding;
  if o.id is null then raise exception 'Onboarding not found'; end if;
  perform public.require_permission(o.company_id, 'onboarding.manage');
  if o.status not in ('pending', 'in_progress') then raise exception 'This onboarding is closed'; end if;
  v := public.onboarding_doc_vars(o.id);
  perform public.enqueue_email(o.company_id, 'documents_requested', v ->> 'candidate_email', v ->> 'candidate_name', v,
    'onboarding:' || o.id || ':documents:' || extract(epoch from clock_timestamp())::bigint, 'onboardings', o.id);
end $$;
revoke execute on function public.resend_onboarding_documents_link(uuid) from public, anon;
grant execute on function public.resend_onboarding_documents_link(uuid) to authenticated;

-- candidate portal (no account): everything is keyed by the secret token from the email
create or replace function public.public_onboarding_documents(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o public.onboardings; c public.companies; v jsonb;
begin
  select * into o from public.onboardings where documents_token = p_token;
  if o.id is null then raise exception 'This link is not valid'; end if;
  select * into c from public.companies where id = o.company_id;
  v := public.onboarding_doc_vars(o.id);
  return jsonb_build_object(
    'onboarding_id', o.id, 'company_id', o.company_id, 'company_name', c.name, 'company_logo', c.logo_url,
    'candidate_name', v ->> 'candidate_name', 'job_title', v ->> 'job_title', 'joining_date', o.joining_date,
    'open', o.status in ('pending', 'in_progress'),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'label', d.label, 'required', d.required,
                    'status', d.status, 'file_name', d.file_name, 'note', d.note) order by d.sort_order)
                  from public.onboarding_documents d where d.onboarding_id = o.id), '[]'::jsonb));
end $$;
grant execute on function public.public_onboarding_documents(uuid) to anon, authenticated;

create or replace function public.public_submit_onboarding_document(p_token uuid, p_document uuid, p_file jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare o public.onboardings; d public.onboarding_documents; v_path text := p_file ->> 'path'; v jsonb;
begin
  select * into o from public.onboardings where documents_token = p_token;
  if o.id is null then raise exception 'This link is not valid'; end if;
  if o.status not in ('pending', 'in_progress') then raise exception 'Document upload is closed for this joining'; end if;
  perform public.check_rate_limit('joining-docs', p_token::text, 60, interval '1 hour');
  select * into d from public.onboarding_documents where id = p_document and onboarding_id = o.id for update;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.status = 'verified' then raise exception 'This document is already verified'; end if;
  if v_path is null or v_path not like o.company_id::text || '/onboarding/' || o.id::text || '/%' or v_path like '%..%' then
    raise exception 'Invalid upload';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'documents' and name = v_path) then
    raise exception 'Upload not found. Please upload again.';
  end if;
  if coalesce((p_file ->> 'size')::bigint, 0) > 10485760 then raise exception 'File must be 10 MB or smaller'; end if;
  update public.onboarding_documents set status = 'submitted', storage_path = v_path,
    file_name = left(coalesce(p_file ->> 'name', 'document'), 200), mime_type = p_file ->> 'mime',
    size_bytes = nullif(p_file ->> 'size', '')::bigint, note = null, submitted_at = now(), verified_by = null, verified_at = null
  where id = d.id;
  if o.status = 'pending' then update public.onboardings set status = 'in_progress' where id = o.id; end if;
  -- one alert to HR when nothing required is outstanding any more (not one per file)
  if not exists (select 1 from public.onboarding_documents x where x.onboarding_id = o.id and x.required and x.status in ('pending', 'rejected')) then
    v := public.onboarding_doc_vars(o.id);
    perform public.notify_permission(o.company_id, 'onboarding.manage', 'onboarding', 'Joining documents ready for verification',
      (v ->> 'candidate_name') || ' has uploaded all required documents', '/app/onboarding/' || o.id);
  end if;
end $$;
grant execute on function public.public_submit_onboarding_document(uuid, uuid, jsonb) to anon, authenticated;

create or replace function public.verify_onboarding_document(p_document uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.onboarding_documents; o public.onboardings; v jsonb;
begin
  select * into d from public.onboarding_documents where id = p_document for update;
  if d.id is null then raise exception 'Document not found'; end if;
  perform public.require_permission(d.company_id, 'onboarding.manage');
  select * into o from public.onboardings where id = d.onboarding_id;
  if o.status not in ('pending', 'in_progress') then raise exception 'This onboarding is closed'; end if;
  if d.status <> 'submitted' and not (d.status = 'verified' and not p_approve) then
    raise exception 'Only uploaded documents can be verified or rejected';
  end if;
  if not p_approve and char_length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Give a reason so the joiner knows what to fix'; end if;
  update public.onboarding_documents set status = case when p_approve then 'verified' else 'rejected' end,
    note = nullif(trim(coalesce(p_note, '')), ''), verified_by = auth.uid(), verified_at = now()
  where id = d.id;
  v := public.onboarding_doc_vars(o.id);
  if not p_approve then
    perform public.enqueue_email(o.company_id, 'document_rejected', v ->> 'candidate_email', v ->> 'candidate_name',
      v || jsonb_build_object('document_name', d.label, 'reason', trim(p_note)),
      'onboarding-doc:' || d.id || ':rejected:' || extract(epoch from clock_timestamp())::bigint, 'onboarding_documents', d.id);
  elsif not exists (select 1 from public.onboarding_documents x where x.onboarding_id = o.id and x.required and x.status <> 'verified') then
    perform public.enqueue_email(o.company_id, 'documents_verified', v ->> 'candidate_email', v ->> 'candidate_name', v,
      'onboarding:' || o.id || ':verified', 'onboardings', o.id);
  end if;
end $$;
revoke execute on function public.verify_onboarding_document(uuid, boolean, text) from public, anon;
grant execute on function public.verify_onboarding_document(uuid, boolean, text) to authenticated;

-- ---------- G. employee login: Employee ID + one-time set-password link ----------
-- tokens live in their own table with RLS and no policies: HR and managers can read employees, but never these secrets
create table if not exists public.employee_activations (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.employee_activations enable row level security;
revoke all on public.employee_activations from public, anon, authenticated;

create or replace function public.issue_login_token(p_employee uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e public.employees; v_token uuid := gen_random_uuid(); v_exp timestamptz := now() + interval '7 days';
begin
  select * into e from public.employees where id = p_employee for update;
  if e.id is null then raise exception 'Employee not found'; end if;
  if e.user_id is not null then raise exception 'This employee already has an HRMS login'; end if;
  if e.email is null then raise exception 'Add a work email for this employee first'; end if;
  insert into public.employee_activations (employee_id, token, expires_at) values (e.id, v_token, v_exp)
  on conflict (employee_id) do update set token = excluded.token, expires_at = excluded.expires_at, created_at = now();
  perform public.enqueue_email(e.company_id, 'employee_credentials', e.email, trim(e.first_name || ' ' || coalesce(e.last_name, '')),
    jsonb_build_object('employee_name', trim(e.first_name || ' ' || coalesce(e.last_name, '')), 'employee_code', e.employee_code,
      'joining_date', public.fmt_date(e.joining_date), 'expires_on', public.fmt_date(v_exp::date),
      'activation_link', public.app_url() || '/activate/' || v_token),
    'login:' || e.id || ':' || v_token, 'employees', e.id);
end $$;
revoke execute on function public.issue_login_token(uuid) from public, anon, authenticated;

-- HR: send (or re-send) the Employee ID + set-password email
create or replace function public.send_employee_login(p_employee uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.employees where id = p_employee;
  if v_company is null then raise exception 'Employee not found'; end if;
  perform public.require_permission(v_company, 'employees.manage');
  perform public.issue_login_token(p_employee);
end $$;
revoke execute on function public.send_employee_login(uuid) from public, anon;
grant execute on function public.send_employee_login(uuid) to authenticated;

create or replace function public.public_employee_activation(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when e.id is null then jsonb_build_object('status', 'invalid')
    else jsonb_build_object(
      'status', case when e.user_id is not null then 'used' when a.expires_at < now() then 'expired' else 'valid' end,
      'employee_name', trim(e.first_name || ' ' || coalesce(e.last_name, '')), 'employee_code', e.employee_code,
      'email', e.email, 'company_name', c.name)
    end
  from (select 1) one
  left join public.employee_activations a on a.token = p_token
  left join public.employees e on e.id = a.employee_id
  left join public.companies c on c.id = e.company_id
$$;
grant execute on function public.public_employee_activation(uuid) to anon, authenticated;

-- called by the employee-auth edge function (service role) right after it created the auth user
create or replace function public.consume_employee_activation(p_token uuid, p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare e public.employees; a public.employee_activations; v_role uuid;
begin
  select * into a from public.employee_activations where token = p_token for update;
  if a.employee_id is null then raise exception 'This link is not valid'; end if;
  select * into e from public.employees where id = a.employee_id for update;
  if e.user_id is not null then raise exception 'This link was already used'; end if;
  if a.expires_at < now() then raise exception 'This link has expired. Ask HR to send a new one.'; end if;
  if not exists (select 1 from auth.users u where u.id = p_user and lower(u.email) = lower(e.email)) then
    raise exception 'Account does not match this employee';
  end if;
  update public.employees set user_id = p_user where id = e.id;
  delete from public.employee_activations where employee_id = e.id;
  select id into v_role from public.roles where company_id = e.company_id and name = 'Employee' limit 1;
  insert into public.company_members (company_id, user_id, role_id, employee_id)
  values (e.company_id, p_user, v_role, e.id)
  on conflict (company_id, user_id) do update set employee_id = coalesce(public.company_members.employee_id, excluded.employee_id);
  update public.profiles set last_company_id = e.company_id where id = p_user;
  return e.company_id;
end $$;
revoke execute on function public.consume_employee_activation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.consume_employee_activation(uuid, uuid) to service_role;

-- sign-in with Employee ID: the edge function resolves the ID to login emails server-side (never shown to the client)
create or replace function public.login_emails_for_code(p_code text) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct lower(u.email)), '{}') from public.employees e join auth.users u on u.id = e.user_id
  where upper(e.employee_code) = upper(trim(p_code)) and e.status not in ('inactive', 'terminated')
$$;
revoke execute on function public.login_emails_for_code(text) from public, anon, authenticated;
grant execute on function public.login_emails_for_code(text) to service_role;

-- complete_onboarding: unchanged except (1) required documents must be verified and (2) the welcome email is now the
-- Employee ID + set-password email instead of a "create an account" link
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
  if exists (select 1 from public.employees where company_id = ob.company_id and lower(email) = lower(cand.email)) then
    raise exception 'An employee with email % already exists', cand.email;
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

-- ---------- H. appointment letter ----------
do $$
declare v_con text;
begin
  select conname into v_con from pg_constraint
  where conrelid = 'public.employee_documents'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%doc_type%';
  if v_con is not null then execute format('alter table public.employee_documents drop constraint %I', v_con); end if;
  alter table public.employee_documents add constraint employee_documents_doc_type_check
    check (doc_type in ('id_proof','address_proof','education','experience','contract','offer_letter','appointment_letter','tax','other'));
end $$;

create or replace function public.send_appointment_letter(p_employee uuid, p_path text, p_file_name text default 'Appointment letter.pdf')
returns void language plpgsql security definer set search_path = public as $$
declare e public.employees; v_size bigint;
begin
  select * into e from public.employees where id = p_employee;
  if e.id is null then raise exception 'Employee not found'; end if;
  perform public.require_permission(e.company_id, 'employees.manage');
  if p_path is null or p_path not like e.company_id::text || '/employees/' || e.id::text || '/%' or p_path like '%..%' then
    raise exception 'Invalid appointment letter file';
  end if;
  select (metadata ->> 'size')::bigint into v_size from storage.objects where bucket_id = 'documents' and name = p_path;
  if not found then raise exception 'Appointment letter upload not found'; end if;
  delete from public.employee_documents where employee_id = e.id and doc_type = 'appointment_letter' and storage_path = p_path;
  insert into public.employee_documents (company_id, employee_id, doc_type, file_name, storage_path, mime_type, size_bytes)
  values (e.company_id, e.id, 'appointment_letter', left(coalesce(p_file_name, 'Appointment letter.pdf'), 200), p_path, 'application/pdf', v_size);
  perform public.enqueue_email(e.company_id, 'appointment_letter', e.email, trim(e.first_name || ' ' || coalesce(e.last_name, '')),
    jsonb_build_object('employee_name', trim(e.first_name || ' ' || coalesce(e.last_name, '')), 'employee_code', e.employee_code,
      'joining_date', public.fmt_date(e.joining_date),
      'designation', coalesce((select title from public.designations where id = e.designation_id), 'your role')),
    'appointment:' || e.id || ':' || md5(p_path), 'employees', e.id,
    jsonb_build_array(jsonb_build_object('bucket', 'documents', 'path', p_path, 'filename', left(coalesce(p_file_name, 'Appointment letter.pdf'), 200))));
end $$;
revoke execute on function public.send_appointment_letter(uuid, text, text) from public, anon;
grant execute on function public.send_appointment_letter(uuid, text, text) to authenticated;
