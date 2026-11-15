-- =====================================================================
-- 1400  RECRUITMENT GAPS
--   * bulk candidate actions (stage change / reject per application, tags)
--   * interview reminder emails (24 h before; pg_cron where available + email worker)
--   * multiple offer-letter templates
--   * careers: education fields + application reference number
-- =====================================================================

-- ---------- application reference number ----------
create or replace function public.application_ref(p_id uuid) returns text
language sql immutable as $$ select 'APP-' || upper(substr(replace(p_id::text, '-', ''), 1, 8)) $$;

-- ---------- bulk actions ----------
-- Applies change_application_stage to each application (same rules, history, emails); failures are reported per item.
create or replace function public.bulk_change_application_stage(p_applications uuid[], p_stage text, p_note text default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_ok int := 0; v_failed jsonb := '[]'::jsonb; v_company uuid;
begin
  if coalesce(array_length(p_applications, 1), 0) = 0 then raise exception 'Select at least one application'; end if;
  if array_length(p_applications, 1) > 200 then raise exception 'Bulk actions are limited to 200 applications at a time'; end if;
  if (select count(distinct company_id) from public.applications where id = any(p_applications)) > 1 then
    raise exception 'All applications must belong to the same company';
  end if;
  select company_id into v_company from public.applications where id = p_applications[1];
  if v_company is null then raise exception 'Application not found'; end if;
  perform public.require_permission(v_company, 'candidates.manage');
  if p_stage = 'rejected' and char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'Please provide a rejection reason'; end if;
  foreach v_id in array p_applications loop
    begin
      perform public.change_application_stage(v_id, p_stage, coalesce(p_note, 'Bulk action'), p_reason);
      v_ok := v_ok + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('id', v_id, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('updated', v_ok, 'failed', v_failed);
end $$;

create or replace function public.bulk_tag_candidates(p_candidates uuid[], p_tag text, p_remove boolean default false) returns integer
language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_tag text := lower(trim(coalesce(p_tag, ''))); n integer;
begin
  if coalesce(array_length(p_candidates, 1), 0) = 0 then raise exception 'Select at least one candidate'; end if;
  if array_length(p_candidates, 1) > 500 then raise exception 'Bulk actions are limited to 500 candidates at a time'; end if;
  if v_tag !~ '^[a-z0-9][a-z0-9 _-]{0,39}$' then raise exception 'Tags must be 1–40 letters, numbers, spaces, - or _'; end if;
  if (select count(distinct company_id) from public.candidates where id = any(p_candidates)) <> 1 then
    raise exception 'All candidates must belong to the same company';
  end if;
  select company_id into v_company from public.candidates where id = p_candidates[1];
  perform public.require_permission(v_company, 'candidates.manage');
  if p_remove then
    update public.candidates set tags = array_remove(tags, v_tag) where id = any(p_candidates) and v_tag = any(tags);
  else
    update public.candidates set tags = tags || v_tag where id = any(p_candidates) and not (v_tag = any(tags));
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- interview reminders ----------
alter table public.interviews add column reminder_sent_at timestamptz;

create or replace function public.interviews_reset_reminder() returns trigger
language plpgsql as $$
begin
  if new.scheduled_at is distinct from old.scheduled_at then new.reminder_sent_at := null; end if;
  return new;
end $$;
create trigger trg_interviews_reset_reminder before update of scheduled_at on public.interviews
  for each row execute function public.interviews_reset_reminder();

create or replace function public.seed_reminder_template(p_company uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.email_templates (company_id, key, name, description, subject, body_html) values
  (p_company, 'interview_reminder', 'Interview reminder', 'Sent to the candidate and panel about 24 hours before an interview',
   'Reminder: {{round_name}} interview tomorrow — {{job_title}}',
   '<p>Hi {{recipient_name}},</p><p>This is a reminder of the upcoming <strong>{{round_name}}</strong> interview for <strong>{{job_title}}</strong>{{candidate_line}}.</p><table style="border-collapse:collapse;margin:12px 0"><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Date</td><td>{{interview_date}}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Time</td><td>{{interview_time}} ({{timezone}})</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Duration</td><td>{{duration}} minutes</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Mode</td><td>{{interview_type}}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Location / link</td><td>{{location}} {{meeting_link}}</td></tr></table><p>Regards,<br/>{{company_name}}</p>')
  on conflict (company_id, key) do nothing
$$;
revoke execute on function public.seed_reminder_template(uuid) from public, anon, authenticated;
select public.seed_reminder_template(id) from public.companies;

create or replace function public.on_company_created_gaps() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_reminder_template(new.id);
  perform public.seed_default_offer_template(new.id);
  return new;
end $$;

-- Queues reminders for interviews starting within the next 24 hours (once per scheduled time).
create or replace function public.send_interview_reminders() returns integer
language plpgsql security definer set search_path = public as $$
declare i record; v_vars jsonb; n integer := 0; p record;
begin
  for i in
    select iv.id, iv.company_id, iv.scheduled_at, ctx.candidate_name, ctx.candidate_email
    from public.interviews iv
    join public.companies co on co.id = iv.company_id and co.status <> 'suspended'
    cross join lateral public.application_context(iv.application_id) ctx
    where iv.status = 'scheduled' and iv.reminder_sent_at is null
      and iv.scheduled_at > now() and iv.scheduled_at <= now() + interval '24 hours'
    for update of iv skip locked
  loop
    v_vars := public.interview_email_vars(i.id);
    perform public.enqueue_email(i.company_id, 'interview_reminder', i.candidate_email, i.candidate_name,
      v_vars || jsonb_build_object('candidate_line', ''),
      'interview:' || i.id || ':reminder:' || extract(epoch from i.scheduled_at)::bigint, 'interviews', i.id);
    for p in select pr.id as user_id, pr.email, coalesce(pr.full_name, pr.email) as name
             from public.interview_panelists ip join public.profiles pr on pr.id = ip.user_id where ip.interview_id = i.id loop
      perform public.enqueue_email(i.company_id, 'interview_reminder', p.email, p.name,
        v_vars || jsonb_build_object('candidate_line', ' with ' || i.candidate_name),
        'interview:' || i.id || ':reminder:' || extract(epoch from i.scheduled_at)::bigint || ':' || p.user_id, 'interviews', i.id);
      perform public.notify_user(i.company_id, p.user_id, 'interview', 'Interview tomorrow',
        (v_vars ->> 'round_name') || ' with ' || i.candidate_name || ' · ' || (v_vars ->> 'interview_date') || ' ' || (v_vars ->> 'interview_time'),
        '/app/recruitment/interviews');
    end loop;
    update public.interviews set reminder_sent_at = now() where id = i.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.send_interview_reminders() from public, anon, authenticated;
grant execute on function public.send_interview_reminders() to service_role;

-- schedule every 15 minutes where pg_cron is enabled (Supabase: Database → Extensions → pg_cron)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('hrms-interview-reminders', '*/15 * * * *', 'select public.send_interview_reminders()');
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped: %', sqlerrm;
end $$;

-- ---------- offer templates ----------
create table public.offer_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  title text not null default 'Offer of Employment' check (char_length(title) between 3 and 80),
  intro text not null check (char_length(intro) between 10 and 4000),
  general_terms text not null check (char_length(general_terms) between 10 and 8000),
  closing text not null check (char_length(closing) between 10 and 2000),
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);
create unique index offer_templates_one_default on public.offer_templates (company_id) where is_default;
create trigger trg_offer_templates_updated before update on public.offer_templates
  for each row execute function public.set_updated_at();
create trigger trg_audit_offer_templates after insert or update or delete on public.offer_templates
  for each row execute function public.audit_trigger();

-- making one template the default clears the previous default
create or replace function public.offer_templates_single_default() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_default then
    update public.offer_templates set is_default = false where company_id = new.company_id and id <> new.id and is_default;
  end if;
  return new;
end $$;
create trigger trg_offer_templates_default before insert or update of is_default on public.offer_templates
  for each row when (new.is_default) execute function public.offer_templates_single_default();

create or replace function public.seed_default_offer_template(p_company uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.offer_templates (company_id, name, title, intro, general_terms, closing, is_default, created_by) values
  (p_company, 'Standard full-time', 'Offer of Employment',
   'We are delighted to offer you the position of {{role}}{{department_clause}} at {{company_name}}. This letter sets out the principal terms of your employment. We were impressed by your experience and believe you will be a great addition to our team.',
   'Your employment will be governed by the company policies in force from time to time. This offer is contingent upon satisfactory verification of your documents and background. Statutory deductions (provident fund, professional tax and income tax) will apply as per law.',
   'Please confirm your acceptance by {{expiry_date}} using the secure link shared with you by email. This offer lapses automatically if not accepted by that date.',
   true, null),
  (p_company, 'Internship', 'Internship Offer',
   'We are pleased to offer you an internship as {{role}}{{department_clause}} at {{company_name}}, starting {{joining_date}}. This internship is designed to give you hands-on experience alongside our team.',
   'The internship does not constitute an offer of permanent employment. You will follow company policies, maintain confidentiality of company information and complete the assignments agreed with your mentor. A certificate will be issued on successful completion.',
   'Please confirm your acceptance by {{expiry_date}} using the secure link shared with you by email.',
   false, null)
  on conflict (company_id, name) do nothing
$$;
revoke execute on function public.seed_default_offer_template(uuid) from public, anon, authenticated;
select public.seed_default_offer_template(id) from public.companies;

create trigger trg_company_created_gaps after insert on public.companies
  for each row execute function public.on_company_created_gaps();

alter table public.offer_templates enable row level security;
create policy "read offer templates" on public.offer_templates for select to authenticated using (
  public.has_permission(company_id, 'offers.view') or public.has_permission(company_id, 'offers.manage') or public.has_permission(company_id, 'offers.approve'));
create policy "offer managers write templates" on public.offer_templates for all to authenticated
  using (public.has_permission(company_id, 'offers.manage')) with check (public.has_permission(company_id, 'offers.manage'));
revoke all on public.offer_templates from anon;

alter table public.offers add column template_id uuid references public.offer_templates(id) on delete set null;
create trigger trg_same_company_template before insert or update of template_id on public.offers for each row
  execute function public.guard_same_company('template_id:offer_templates');

create or replace view public.v_offers with (security_invoker = true) as
select o.id, o.company_id, o.offer_number, o.application_id, o.candidate_id, o.job_id, o.designation_id, o.department_id,
  o.reporting_manager_id, o.employment_type, o.work_location, o.ctc_annual, o.basic_monthly, o.hra_monthly,
  o.allowances_monthly, o.joining_date, o.expiry_date, o.probation_months, o.additional_terms, o.status, o.pdf_path,
  o.token_expires_at, o.sent_at, o.viewed_at, o.responded_at, o.candidate_signature, o.decline_reason, o.approved_by,
  o.approved_at, o.created_by, o.created_at, o.updated_at,
  trim(c.first_name || ' ' || c.last_name) as candidate_name, c.email as candidate_email, j.title as job_title,
  g.title as designation_title, d.name as department_name, trim(m.first_name || ' ' || m.last_name) as reporting_manager_name,
  coalesce(cp.full_name, cp.email) as created_by_name, coalesce(ap.full_name, ap.email) as approved_by_name,
  o.template_id
from public.offers o
join public.candidates c on c.id = o.candidate_id
join public.jobs j on j.id = o.job_id
left join public.designations g on g.id = o.designation_id
left join public.departments d on d.id = o.department_id
left join public.employees m on m.id = o.reporting_manager_id
left join public.profiles cp on cp.id = o.created_by
left join public.profiles ap on ap.id = o.approved_by;

-- ---------- careers: education ----------
alter table public.candidates
  add column highest_qualification text check (highest_qualification is null or char_length(highest_qualification) <= 100),
  add column institution text check (institution is null or char_length(institution) <= 150),
  add column graduation_year integer check (graduation_year is null or graduation_year between 1950 and 2100);

drop view if exists public.v_candidates;
create view public.v_candidates with (security_invoker = true) as
select c.*, trim(c.first_name || ' ' || c.last_name) as full_name,
  (select count(*) from public.applications a where a.candidate_id = c.id) as applications_count,
  la.stage as latest_stage, la.job_title as latest_job_title, la.applied_at as last_applied_at,
  exists (select 1 from public.candidate_documents cd where cd.candidate_id = c.id and cd.doc_type = 'resume') as has_resume
from public.candidates c
left join lateral (select a.stage, j.title as job_title, a.applied_at from public.applications a
                   join public.jobs j on j.id = a.job_id where a.candidate_id = c.id order by a.applied_at desc limit 1) la on true;
revoke all on public.v_candidates from anon;

-- identical to 0600 plus education fields, graduation-year validation and the reference number in the result
create or replace function public.public_submit_application(p_slug text, p_job uuid, p_data jsonb, p_resume jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.companies;
  j public.jobs;
  v_email text := lower(trim(coalesce(p_data ->> 'email', '')));
  v_first text := trim(coalesce(p_data ->> 'first_name', ''));
  v_last text := trim(coalesce(p_data ->> 'last_name', ''));
  v_phone text := trim(coalesce(p_data ->> 'phone', ''));
  v_qual text := nullif(trim(coalesce(p_data ->> 'highest_qualification', '')), '');
  v_inst text := nullif(trim(coalesce(p_data ->> 'institution', '')), '');
  v_grad integer;
  v_ip text;
  v_candidate uuid;
  v_app uuid;
  v_path text;
  v_skills text[];
begin
  select * into c from public.companies where slug = lower(p_slug) and careers_enabled and status <> 'suspended';
  if c.id is null then raise exception 'Careers page not found'; end if;
  select * into j from public.jobs where id = p_job and company_id = c.id and status = 'published'
    and (closing_date is null or closing_date >= current_date);
  if j.id is null then raise exception 'This job is no longer accepting applications'; end if;

  -- validation
  if char_length(v_first) < 1 or char_length(v_first) > 60 then raise exception 'First name is required (max 60 characters)'; end if;
  if char_length(v_last) > 60 then raise exception 'Last name is too long'; end if;
  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' or char_length(v_email) > 254 then raise exception 'Enter a valid email address'; end if;
  if v_phone !~ '^[+0-9 ()-]{7,20}$' then raise exception 'Enter a valid phone number'; end if;
  if char_length(coalesce(p_data ->> 'cover_letter', '')) > 5000 then raise exception 'Cover letter is too long (max 5000 characters)'; end if;
  if (p_data ? 'experience_years') and nullif(p_data ->> 'experience_years', '') is not null
     and ((p_data ->> 'experience_years')::numeric < 0 or (p_data ->> 'experience_years')::numeric > 60) then
    raise exception 'Experience must be between 0 and 60 years';
  end if;
  if char_length(coalesce(v_qual, '')) > 100 then raise exception 'Qualification is too long (max 100 characters)'; end if;
  if char_length(coalesce(v_inst, '')) > 150 then raise exception 'Institution is too long (max 150 characters)'; end if;
  if nullif(p_data ->> 'graduation_year', '') is not null then
    if (p_data ->> 'graduation_year') !~ '^[0-9]{4}$' then raise exception 'Enter a valid graduation year'; end if;
    v_grad := (p_data ->> 'graduation_year')::integer;
    if v_grad < 1950 or v_grad > extract(year from current_date)::int + 6 then raise exception 'Enter a valid graduation year'; end if;
  end if;

  -- rate limiting: per email and per client IP (from PostgREST request headers when available)
  v_ip := coalesce(split_part(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ',', 1), 'no-ip');
  perform public.check_rate_limit('apply:email', v_email, 5, interval '1 hour');
  perform public.check_rate_limit('apply:ip', v_ip, 30, interval '1 hour');

  -- resume must be an object this flow uploaded into the company's incoming folder
  if p_resume is not null and nullif(p_resume ->> 'path', '') is not null then
    v_path := p_resume ->> 'path';
    if v_path not like c.id::text || '/incoming/%' or v_path like '%..%' then raise exception 'Invalid resume upload'; end if;
    if not exists (select 1 from storage.objects where bucket_id = 'resumes' and name = v_path) then
      raise exception 'Resume upload not found. Please upload again.';
    end if;
    if coalesce((p_resume ->> 'size')::bigint, 0) > 5242880 then raise exception 'Resume must be 5 MB or smaller'; end if;
  else
    raise exception 'Please attach your resume';
  end if;

  select array_agg(distinct trim(s)) into v_skills
  from unnest(string_to_array(coalesce(p_data ->> 'skills', ''), ',')) s where trim(s) <> '';

  select id into v_candidate from public.candidates where company_id = c.id and lower(email) = v_email;
  if v_candidate is null then
    insert into public.candidates (company_id, first_name, last_name, email, phone, current_location, current_company,
      current_title, experience_years, current_ctc, expected_ctc, notice_period_days, linkedin_url, portfolio_url, skills, source,
      highest_qualification, institution, graduation_year)
    values (c.id, v_first, v_last, v_email, v_phone, nullif(p_data ->> 'current_location', ''), nullif(p_data ->> 'current_company', ''),
      nullif(p_data ->> 'current_title', ''), nullif(p_data ->> 'experience_years', '')::numeric,
      nullif(p_data ->> 'current_ctc', '')::numeric, nullif(p_data ->> 'expected_ctc', '')::numeric,
      nullif(p_data ->> 'notice_period_days', '')::integer, nullif(p_data ->> 'linkedin_url', ''),
      nullif(p_data ->> 'portfolio_url', ''), coalesce(v_skills, '{}'), 'careers', v_qual, v_inst, v_grad)
    returning id into v_candidate;
  else
    if exists (select 1 from public.applications where job_id = j.id and candidate_id = v_candidate) then
      raise exception 'You have already applied for this position with this email address' using errcode = '23505';
    end if;
    update public.candidates set
      phone = v_phone,
      current_location = coalesce(nullif(p_data ->> 'current_location', ''), current_location),
      current_company = coalesce(nullif(p_data ->> 'current_company', ''), current_company),
      current_title = coalesce(nullif(p_data ->> 'current_title', ''), current_title),
      experience_years = coalesce(nullif(p_data ->> 'experience_years', '')::numeric, experience_years),
      expected_ctc = coalesce(nullif(p_data ->> 'expected_ctc', '')::numeric, expected_ctc),
      notice_period_days = coalesce(nullif(p_data ->> 'notice_period_days', '')::integer, notice_period_days),
      linkedin_url = coalesce(nullif(p_data ->> 'linkedin_url', ''), linkedin_url),
      highest_qualification = coalesce(v_qual, highest_qualification),
      institution = coalesce(v_inst, institution),
      graduation_year = coalesce(v_grad, graduation_year),
      skills = (select array(select distinct unnest(skills || coalesce(v_skills, '{}'))))
    where id = v_candidate;
  end if;

  insert into public.applications (company_id, job_id, candidate_id, cover_letter, source)
  values (c.id, j.id, v_candidate, nullif(p_data ->> 'cover_letter', ''), 'careers')
  returning id into v_app;

  insert into public.candidate_documents (company_id, candidate_id, application_id, doc_type, file_name, storage_bucket,
    storage_path, mime_type, size_bytes, uploaded_by)
  values (c.id, v_candidate, v_app, 'resume', left(coalesce(p_resume ->> 'name', 'resume'), 200), 'resumes', v_path,
    p_resume ->> 'mime', nullif(p_resume ->> 'size', '')::bigint, null);

  return jsonb_build_object('application_id', v_app, 'reference_no', public.application_ref(v_app),
                            'job_title', j.title, 'company_name', c.name);
end $$;
grant execute on function public.public_submit_application(text, uuid, jsonb, jsonb) to anon, authenticated;
