-- =====================================================================
-- 0300  RECRUITMENT: requisitions, jobs, candidates, applications,
--       documents, interviews, feedback, offers, onboarding
-- =====================================================================

create table public.job_requisitions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 120),
  department_id uuid references public.departments(id) on delete set null,
  designation_id uuid references public.designations(id) on delete set null,
  headcount integer not null default 1 check (headcount between 1 and 500),
  employment_type text not null default 'full_time' check (employment_type in ('full_time','part_time','contract','intern')),
  location text,
  min_salary numeric(14,2) check (min_salary >= 0),
  max_salary numeric(14,2) check (max_salary >= 0),
  justification text not null check (char_length(justification) between 10 and 4000),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  target_date date,
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','rejected','closed')),
  requested_by uuid default auth.uid() references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (max_salary is null or min_salary is null or max_salary >= min_salary)
);
create index job_requisitions_company_idx on public.job_requisitions (company_id, status);
create trigger trg_job_requisitions_updated before update on public.job_requisitions
  for each row execute function public.set_updated_at();

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  requisition_id uuid references public.job_requisitions(id) on delete set null,
  title text not null check (char_length(title) between 3 and 120),
  department_id uuid references public.departments(id) on delete set null,
  designation_id uuid references public.designations(id) on delete set null,
  location text not null default 'Head Office',
  employment_type text not null default 'full_time' check (employment_type in ('full_time','part_time','contract','intern')),
  work_mode text not null default 'onsite' check (work_mode in ('onsite','remote','hybrid')),
  experience_min numeric(4,1) not null default 0 check (experience_min >= 0),
  experience_max numeric(4,1) check (experience_max >= 0),
  salary_min numeric(14,2) check (salary_min >= 0),
  salary_max numeric(14,2) check (salary_max >= 0),
  show_salary boolean not null default false,
  openings integer not null default 1 check (openings between 1 and 500),
  description text not null check (char_length(description) >= 20),
  responsibilities text,
  requirements text,
  benefits text,
  skills text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft','published','on_hold','closed')),
  published_at timestamptz,
  closing_date date,
  hiring_manager_id uuid references auth.users(id) on delete set null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (experience_max is null or experience_max >= experience_min),
  check (salary_max is null or salary_min is null or salary_max >= salary_min)
);
create index jobs_company_status_idx on public.jobs (company_id, status);
create trigger trg_jobs_updated before update on public.jobs
  for each row execute function public.set_updated_at();

create or replace function public.jobs_set_published_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') and new.published_at is null then
    new.published_at := now();
  end if;
  return new;
end $$;
create trigger trg_jobs_published before insert or update on public.jobs
  for each row execute function public.jobs_set_published_at();

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  first_name text not null check (char_length(first_name) between 1 and 60),
  last_name text not null default '',
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text,
  current_location text,
  current_company text,
  current_title text,
  experience_years numeric(4,1) check (experience_years between 0 and 60),
  current_ctc numeric(14,2) check (current_ctc >= 0),
  expected_ctc numeric(14,2) check (expected_ctc >= 0),
  notice_period_days integer check (notice_period_days between 0 and 365),
  linkedin_url text,
  portfolio_url text,
  skills text[] not null default '{}',
  tags text[] not null default '{}',
  source text not null default 'careers' check (source in ('careers','referral','linkedin','agency','direct','job_board','other')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index candidates_email_idx on public.candidates (company_id, lower(email));
create index candidates_company_idx on public.candidates (company_id, created_at desc);
create trigger trg_candidates_updated before update on public.candidates
  for each row execute function public.set_updated_at();

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  stage text not null default 'applied' check (stage in
    ('applied','screening','shortlisted','interview','selected','offered','hired','rejected','on_hold','withdrawn')),
  cover_letter text,
  source text not null default 'careers',
  rating smallint check (rating between 1 and 5),
  rejection_reason text,
  assigned_to uuid references auth.users(id) on delete set null,
  applied_at timestamptz not null default now(),
  stage_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, candidate_id)
);
create index applications_company_stage_idx on public.applications (company_id, stage);
create index applications_candidate_idx on public.applications (candidate_id);
create index applications_job_idx on public.applications (job_id);
create trigger trg_applications_updated before update on public.applications
  for each row execute function public.set_updated_at();

create table public.application_stage_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  from_stage text,
  to_stage text not null,
  note text,
  changed_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index stage_history_app_idx on public.application_stage_history (application_id, created_at);

create or replace function public.track_application_stage() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.application_stage_history (company_id, application_id, from_stage, to_stage, note)
    values (new.company_id, new.id, null, new.stage, 'Application received');
  elsif new.stage is distinct from old.stage then
    new.stage_changed_at := now();
    insert into public.application_stage_history (company_id, application_id, from_stage, to_stage, note)
    values (new.company_id, new.id, old.stage, new.stage, nullif(current_setting('hrms.stage_note', true), ''));
  end if;
  return new;
end $$;
create trigger trg_applications_stage_ins after insert on public.applications
  for each row execute function public.track_application_stage();
create trigger trg_applications_stage_upd before update of stage on public.applications
  for each row execute function public.track_application_stage();

create table public.candidate_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index candidate_notes_idx on public.candidate_notes (candidate_id, created_at desc);

create table public.candidate_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  application_id uuid references public.applications(id) on delete set null,
  doc_type text not null default 'resume' check (doc_type in ('resume','cover_letter','id_proof','certificate','offer_letter','other')),
  file_name text not null,
  storage_bucket text not null default 'resumes' check (storage_bucket in ('resumes','documents')),
  storage_path text not null,
  mime_type text,
  size_bytes bigint check (size_bytes between 0 and 10485760),
  uploaded_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index candidate_documents_idx on public.candidate_documents (candidate_id);

-- ---------- interviews ----------
create table public.interviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  round_name text not null default 'Round 1' check (char_length(round_name) between 2 and 80),
  interview_type text not null default 'video' check (interview_type in ('phone','video','onsite','technical','hr')),
  scheduled_at timestamptz not null,
  duration_minutes integer not null default 60 check (duration_minutes between 15 and 480),
  location text,
  meeting_link text,
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled','no_show')),
  notes text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index interviews_company_time_idx on public.interviews (company_id, scheduled_at);
create index interviews_application_idx on public.interviews (application_id);
create trigger trg_interviews_updated before update on public.interviews
  for each row execute function public.set_updated_at();

create table public.interview_panelists (
  interview_id uuid not null references public.interviews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  primary key (interview_id, user_id)
);
create index interview_panelists_user_idx on public.interview_panelists (user_id);

create table public.interview_feedback (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  interview_id uuid not null references public.interviews(id) on delete cascade,
  interviewer_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  overall_rating smallint not null check (overall_rating between 1 and 5),
  technical_rating smallint check (technical_rating between 1 and 5),
  communication_rating smallint check (communication_rating between 1 and 5),
  culture_rating smallint check (culture_rating between 1 and 5),
  recommendation text not null check (recommendation in ('strong_hire','hire','no_hire','strong_no_hire')),
  strengths text,
  weaknesses text,
  comments text,
  submitted_at timestamptz not null default now(),
  unique (interview_id, interviewer_id)
);

-- ---------- offers ----------
create table public.offers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  offer_number text,
  application_id uuid not null references public.applications(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  designation_id uuid references public.designations(id) on delete set null,
  department_id uuid references public.departments(id) on delete set null,
  reporting_manager_id uuid references public.employees(id) on delete set null,
  employment_type text not null default 'full_time' check (employment_type in ('full_time','part_time','contract','intern')),
  work_location text,
  ctc_annual numeric(14,2) not null check (ctc_annual > 0),
  basic_monthly numeric(12,2) not null default 0 check (basic_monthly >= 0),
  hra_monthly numeric(12,2) not null default 0 check (hra_monthly >= 0),
  allowances_monthly numeric(12,2) not null default 0 check (allowances_monthly >= 0),
  joining_date date not null,
  expiry_date date not null,
  probation_months integer not null default 6 check (probation_months between 0 and 24),
  additional_terms text,
  status text not null default 'draft' check (status in
    ('draft','pending_approval','approved','rejected','sent','accepted','declined','expired','withdrawn')),
  pdf_path text,
  token_hash text unique,
  token_expires_at timestamptz,
  sent_at timestamptz,
  viewed_at timestamptz,
  responded_at timestamptz,
  candidate_signature text,
  decline_reason text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expiry_date >= created_at::date)
);
create index offers_company_status_idx on public.offers (company_id, status);
create index offers_application_idx on public.offers (application_id);
-- only one live offer per application
create unique index offers_one_active_idx on public.offers (application_id)
  where status in ('draft','pending_approval','approved','sent','accepted');
create trigger trg_offers_updated before update on public.offers
  for each row execute function public.set_updated_at();

create or replace function public.assign_offer_number() returns trigger
language plpgsql as $$
begin
  if new.offer_number is null then
    new.offer_number := 'OFR-' || to_char(now(), 'YYYYMM') || '-' || upper(substr(replace(new.id::text, '-', ''), 1, 6));
  end if;
  return new;
end $$;
create trigger trg_offers_number before insert on public.offers
  for each row execute function public.assign_offer_number();

create table public.offer_approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  offer_id uuid not null references public.offers(id) on delete cascade,
  action text not null check (action in ('submitted','approved','rejected','sent','withdrawn','accepted','declined')),
  comments text,
  actor_id uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index offer_approvals_offer_idx on public.offer_approvals (offer_id, created_at);

-- ---------- onboarding ----------
create table public.onboarding_task_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 120),
  description text,
  category text not null default 'hr' check (category in ('hr','it','manager','employee','finance')),
  due_offset_days integer not null default 0 check (due_offset_days between -60 and 120),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.onboardings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  offer_id uuid not null unique references public.offers(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','in_progress','completed','cancelled')),
  joining_date date not null,
  joining_confirmed boolean not null default false,
  joining_confirmed_at timestamptz,
  employee_id uuid references public.employees(id) on delete set null,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index onboardings_company_idx on public.onboardings (company_id, status);
create trigger trg_onboardings_updated before update on public.onboardings
  for each row execute function public.set_updated_at();

create table public.onboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  onboarding_id uuid not null references public.onboardings(id) on delete cascade,
  title text not null,
  description text,
  category text not null default 'hr',
  due_date date,
  sort_order integer not null default 0,
  is_completed boolean not null default false,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index onboarding_tasks_idx on public.onboarding_tasks (onboarding_id, sort_order);

-- ---------- public submission rate limiting ----------
create table public.public_submission_log (
  id bigint generated always as identity primary key,
  action text not null,
  key_hash text not null,
  created_at timestamptz not null default now()
);
create index public_submission_log_idx on public.public_submission_log (action, key_hash, created_at desc);
