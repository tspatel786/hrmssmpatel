-- =====================================================================
-- 0600  RECRUITMENT LOGIC: public careers API, pipeline automation,
--       interviews, feedback, offers (approval, secure acceptance),
--       onboarding → employee creation
-- =====================================================================

create or replace function public.require_permission(p_company uuid, p_permission text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_permission(p_company, p_permission) then
    raise exception 'Permission denied: % is required', p_permission using errcode = '42501';
  end if;
end $$;

-- ======================= PUBLIC CAREERS API =========================
create or replace function public.public_company(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'name', name, 'slug', slug, 'logo_url', logo_url, 'primary_color', primary_color,
    'tagline', careers_tagline, 'about', careers_about, 'website', website, 'city', city, 'country', country)
  from public.companies
  where slug = lower(p_slug) and careers_enabled and status <> 'suspended'
$$;

create or replace function public.public_jobs(p_slug text)
returns table (id uuid, title text, department text, location text, employment_type text, work_mode text,
  experience_min numeric, experience_max numeric, salary_min numeric, salary_max numeric, currency text,
  skills text[], published_at timestamptz, closing_date date)
language sql stable security definer set search_path = public as $$
  select j.id, j.title, d.name, j.location, j.employment_type, j.work_mode, j.experience_min, j.experience_max,
    case when j.show_salary then j.salary_min end, case when j.show_salary then j.salary_max end, c.currency,
    j.skills, j.published_at, j.closing_date
  from public.jobs j
  join public.companies c on c.id = j.company_id
  left join public.departments d on d.id = j.department_id
  where c.slug = lower(p_slug) and c.careers_enabled and c.status <> 'suspended'
    and j.status = 'published' and (j.closing_date is null or j.closing_date >= current_date)
  order by j.published_at desc nulls last
$$;

create or replace function public.public_job(p_slug text, p_job uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', j.id, 'title', j.title, 'department', d.name, 'location', j.location,
    'employment_type', j.employment_type, 'work_mode', j.work_mode, 'experience_min', j.experience_min,
    'experience_max', j.experience_max, 'salary_min', case when j.show_salary then j.salary_min end,
    'salary_max', case when j.show_salary then j.salary_max end, 'currency', c.currency, 'openings', j.openings,
    'description', j.description, 'responsibilities', j.responsibilities, 'requirements', j.requirements,
    'benefits', j.benefits, 'skills', j.skills, 'published_at', j.published_at, 'closing_date', j.closing_date)
  from public.jobs j
  join public.companies c on c.id = j.company_id
  left join public.departments d on d.id = j.department_id
  where c.slug = lower(p_slug) and j.id = p_job and c.careers_enabled and c.status <> 'suspended'
    and j.status = 'published' and (j.closing_date is null or j.closing_date >= current_date)
$$;

-- Rate-limit helper: records the hit and raises if over the limit.
create or replace function public.check_rate_limit(p_action text, p_key text, p_max integer, p_window interval) returns void
language plpgsql security definer set search_path = public as $$
declare v_hash text := encode(sha256(convert_to(lower(coalesce(p_key, 'unknown')), 'UTF8')), 'hex');
begin
  if (select count(*) from public.public_submission_log
      where action = p_action and key_hash = v_hash and created_at > now() - p_window) >= p_max then
    raise exception 'Too many submissions. Please try again later.' using errcode = 'P0429';
  end if;
  insert into public.public_submission_log (action, key_hash) values (p_action, v_hash);
  delete from public.public_submission_log where created_at < now() - interval '2 days';
end $$;
revoke execute on function public.check_rate_limit(text, text, integer, interval) from public, anon, authenticated;

create or replace function public.public_submit_application(p_slug text, p_job uuid, p_data jsonb, p_resume jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.companies;
  j public.jobs;
  v_email text := lower(trim(coalesce(p_data ->> 'email', '')));
  v_first text := trim(coalesce(p_data ->> 'first_name', ''));
  v_last text := trim(coalesce(p_data ->> 'last_name', ''));
  v_phone text := trim(coalesce(p_data ->> 'phone', ''));
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
      current_title, experience_years, current_ctc, expected_ctc, notice_period_days, linkedin_url, portfolio_url, skills, source)
    values (c.id, v_first, v_last, v_email, v_phone, nullif(p_data ->> 'current_location', ''), nullif(p_data ->> 'current_company', ''),
      nullif(p_data ->> 'current_title', ''), nullif(p_data ->> 'experience_years', '')::numeric,
      nullif(p_data ->> 'current_ctc', '')::numeric, nullif(p_data ->> 'expected_ctc', '')::numeric,
      nullif(p_data ->> 'notice_period_days', '')::integer, nullif(p_data ->> 'linkedin_url', ''),
      nullif(p_data ->> 'portfolio_url', ''), coalesce(v_skills, '{}'), 'careers')
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

  return jsonb_build_object('application_id', v_app, 'job_title', j.title, 'company_name', c.name);
end $$;
grant execute on function public.public_company(text) to anon, authenticated;
grant execute on function public.public_jobs(text) to anon, authenticated;
grant execute on function public.public_job(text, uuid) to anon, authenticated;
grant execute on function public.public_submit_application(text, uuid, jsonb, jsonb) to anon, authenticated;

-- ======================= PIPELINE AUTOMATION =========================
create or replace function public.application_context(p_app uuid)
returns table (company_id uuid, candidate_name text, candidate_email text, job_title text, job_id uuid, candidate_id uuid)
language sql stable security definer set search_path = public as $$
  select a.company_id, trim(c.first_name || ' ' || c.last_name), c.email, j.title, j.id, c.id
  from public.applications a
  join public.candidates c on c.id = a.candidate_id
  join public.jobs j on j.id = a.job_id
  where a.id = p_app
$$;
revoke execute on function public.application_context(uuid) from public, anon, authenticated;

create or replace function public.on_application_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare ctx record; v_tpl text;
begin
  select * into ctx from public.application_context(new.id);
  if tg_op = 'INSERT' then
    perform public.enqueue_email(new.company_id, 'application_received', ctx.candidate_email, ctx.candidate_name,
      jsonb_build_object('candidate_name', ctx.candidate_name, 'job_title', ctx.job_title),
      'app:' || new.id || ':received', 'applications', new.id);
    perform public.notify_permission(new.company_id, 'candidates.manage', 'application', 'New application',
      ctx.candidate_name || ' applied for ' || ctx.job_title, '/app/recruitment/candidates/' || ctx.candidate_id);
    return new;
  end if;
  if new.stage is not distinct from old.stage then return new; end if;
  v_tpl := case new.stage
    when 'shortlisted' then 'candidate_shortlisted'
    when 'on_hold' then 'application_on_hold'
    when 'rejected' then 'application_rejected'
    when 'selected' then 'candidate_selected'
  end;
  if v_tpl is not null then
    perform public.enqueue_email(new.company_id, v_tpl, ctx.candidate_email, ctx.candidate_name,
      jsonb_build_object('candidate_name', ctx.candidate_name, 'job_title', ctx.job_title),
      'app:' || new.id || ':' || new.stage, 'applications', new.id);
  end if;
  return new;
end $$;
create trigger trg_applications_automation after insert or update of stage on public.applications
  for each row execute function public.on_application_change();

create or replace function public.change_application_stage(p_application uuid, p_stage text, p_note text default null, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare a public.applications;
begin
  select * into a from public.applications where id = p_application;
  if a.id is null then raise exception 'Application not found'; end if;
  perform public.require_permission(a.company_id, 'candidates.manage');
  if p_stage not in ('applied','screening','shortlisted','interview','selected','rejected','on_hold','withdrawn') then
    raise exception 'Stage "%" cannot be set manually (offers and hiring are driven by the offer and onboarding workflow)', p_stage;
  end if;
  if a.stage = 'hired' then raise exception 'Candidate has already been hired'; end if;
  if a.stage = 'offered' and exists (select 1 from public.offers where application_id = a.id and status in ('sent','accepted')) then
    raise exception 'An offer is active for this application. Withdraw the offer first.';
  end if;
  if p_stage = 'rejected' and char_length(coalesce(trim(p_reason), '')) < 3 then
    raise exception 'Please provide a rejection reason';
  end if;
  perform set_config('hrms.stage_note', coalesce(p_note, ''), true);
  update public.applications set stage = p_stage,
    rejection_reason = case when p_stage = 'rejected' then p_reason else rejection_reason end
  where id = p_application;
  perform set_config('hrms.stage_note', '', true);
end $$;

-- ======================= INTERVIEWS =========================
create or replace function public.interview_email_vars(p_interview uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'candidate_name', ctx.candidate_name, 'job_title', ctx.job_title, 'round_name', i.round_name,
    'interview_date', to_char(i.scheduled_at at time zone tz.tz, 'Dy, DD Mon YYYY'),
    'interview_time', to_char(i.scheduled_at at time zone tz.tz, 'HH12:MI AM'),
    'timezone', tz.tz, 'duration', i.duration_minutes::text,
    'interview_type', initcap(i.interview_type),
    'location', coalesce(i.location, ''), 'meeting_link', coalesce(i.meeting_link, ''))
  from public.interviews i
  cross join lateral public.application_context(i.application_id) ctx
  cross join lateral (select public.company_tz(i.company_id) as tz) tz
  where i.id = p_interview
$$;
revoke execute on function public.interview_email_vars(uuid) from public, anon, authenticated;

create or replace function public.check_interview_conflicts(p_company uuid, p_interview uuid, p_application uuid,
  p_at timestamptz, p_duration integer, p_panelists uuid[]) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_name text;
begin
  select coalesce(p.full_name, p.email) into v_name
  from public.interviews i
  join public.interview_panelists ip on ip.interview_id = i.id
  join public.profiles p on p.id = ip.user_id
  where i.company_id = p_company and i.status = 'scheduled' and i.id is distinct from p_interview
    and ip.user_id = any(p_panelists)
    and tstzrange(i.scheduled_at, i.scheduled_at + make_interval(mins => i.duration_minutes))
        && tstzrange(p_at, p_at + make_interval(mins => p_duration))
  limit 1;
  if v_name is not null then
    raise exception 'Scheduling conflict: % already has an interview at this time', v_name using errcode = 'P0409';
  end if;
  if exists (select 1 from public.interviews i
             where i.application_id = p_application and i.status = 'scheduled' and i.id is distinct from p_interview
               and tstzrange(i.scheduled_at, i.scheduled_at + make_interval(mins => i.duration_minutes))
                   && tstzrange(p_at, p_at + make_interval(mins => p_duration))) then
    raise exception 'Scheduling conflict: the candidate already has an interview at this time' using errcode = 'P0409';
  end if;
end $$;

create or replace function public.schedule_interview(p_application uuid, p_round text, p_type text, p_at timestamptz,
  p_duration integer, p_location text, p_meeting_link text, p_panelists uuid[], p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare a public.applications; v_id uuid; v_vars jsonb; r record;
begin
  select * into a from public.applications where id = p_application;
  if a.id is null then raise exception 'Application not found'; end if;
  perform public.require_permission(a.company_id, 'interviews.manage');
  if a.stage in ('rejected','withdrawn','hired') then raise exception 'Cannot schedule interviews for a % application', a.stage; end if;
  if p_at < now() - interval '5 minutes' then raise exception 'Interview time must be in the future'; end if;
  if coalesce(array_length(p_panelists, 1), 0) = 0 then raise exception 'Select at least one interviewer'; end if;
  if exists (select 1 from unnest(p_panelists) u
             where not exists (select 1 from public.company_members m where m.company_id = a.company_id and m.user_id = u and m.status = 'active')) then
    raise exception 'All interviewers must be active members of the company';
  end if;
  perform public.check_interview_conflicts(a.company_id, null, a.id, p_at, p_duration, p_panelists);

  insert into public.interviews (company_id, application_id, round_name, interview_type, scheduled_at, duration_minutes,
    location, meeting_link, notes)
  values (a.company_id, a.id, p_round, p_type, p_at, p_duration, nullif(p_location, ''), nullif(p_meeting_link, ''), p_notes)
  returning id into v_id;
  insert into public.interview_panelists (interview_id, user_id, company_id)
    select v_id, u, a.company_id from unnest(p_panelists) u group by u;

  if a.stage in ('applied','screening','shortlisted','on_hold') then
    perform set_config('hrms.stage_note', 'Interview scheduled: ' || p_round, true);
    update public.applications set stage = 'interview' where id = a.id;
  end if;

  v_vars := public.interview_email_vars(v_id);
  perform public.enqueue_email(a.company_id, 'interview_scheduled', ctx.candidate_email, ctx.candidate_name, v_vars,
    'interview:' || v_id || ':scheduled:' || extract(epoch from p_at)::bigint, 'interviews', v_id)
  from public.application_context(a.id) ctx;
  for r in select p.id, p.email, coalesce(p.full_name, p.email) as name from public.profiles p where p.id = any(p_panelists) loop
    perform public.enqueue_email(a.company_id, 'interviewer_assigned', r.email, r.name, v_vars,
      'interview:' || v_id || ':panel:' || r.id || ':' || extract(epoch from p_at)::bigint, 'interviews', v_id);
    perform public.notify_user(a.company_id, r.id, 'interview', 'Interview assigned',
      (v_vars ->> 'candidate_name') || ' · ' || (v_vars ->> 'interview_date') || ' ' || (v_vars ->> 'interview_time'),
      '/app/recruitment/interviews');
  end loop;
  return v_id;
end $$;

create or replace function public.reschedule_interview(p_interview uuid, p_at timestamptz, p_duration integer,
  p_location text, p_meeting_link text, p_panelists uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare i public.interviews; v_vars jsonb; r record;
begin
  select * into i from public.interviews where id = p_interview;
  if i.id is null then raise exception 'Interview not found'; end if;
  perform public.require_permission(i.company_id, 'interviews.manage');
  if i.status <> 'scheduled' then raise exception 'Only scheduled interviews can be rescheduled'; end if;
  if p_at < now() - interval '5 minutes' then raise exception 'Interview time must be in the future'; end if;
  if coalesce(array_length(p_panelists, 1), 0) = 0 then raise exception 'Select at least one interviewer'; end if;
  perform public.check_interview_conflicts(i.company_id, i.id, i.application_id, p_at, p_duration, p_panelists);

  update public.interviews set scheduled_at = p_at, duration_minutes = p_duration,
    location = nullif(p_location, ''), meeting_link = nullif(p_meeting_link, '') where id = i.id;
  delete from public.interview_panelists where interview_id = i.id and user_id <> all(p_panelists);
  insert into public.interview_panelists (interview_id, user_id, company_id)
    select i.id, u, i.company_id from unnest(p_panelists) u group by u on conflict do nothing;

  if p_at is distinct from i.scheduled_at then
    v_vars := public.interview_email_vars(i.id);
    perform public.enqueue_email(i.company_id, 'interview_rescheduled', ctx.candidate_email, ctx.candidate_name, v_vars,
      'interview:' || i.id || ':rescheduled:' || extract(epoch from p_at)::bigint, 'interviews', i.id)
    from public.application_context(i.application_id) ctx;
    for r in select p.id, p.email, coalesce(p.full_name, p.email) as name from public.profiles p where p.id = any(p_panelists) loop
      perform public.enqueue_email(i.company_id, 'interviewer_assigned', r.email, r.name, v_vars,
        'interview:' || i.id || ':panel:' || r.id || ':' || extract(epoch from p_at)::bigint, 'interviews', i.id);
      perform public.notify_user(i.company_id, r.id, 'interview', 'Interview rescheduled',
        (v_vars ->> 'candidate_name') || ' · ' || (v_vars ->> 'interview_date') || ' ' || (v_vars ->> 'interview_time'),
        '/app/recruitment/interviews');
    end loop;
  end if;
end $$;

create or replace function public.cancel_interview(p_interview uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare i public.interviews; v_vars jsonb;
begin
  select * into i from public.interviews where id = p_interview;
  if i.id is null then raise exception 'Interview not found'; end if;
  perform public.require_permission(i.company_id, 'interviews.manage');
  if i.status <> 'scheduled' then raise exception 'Only scheduled interviews can be cancelled'; end if;
  update public.interviews set status = 'cancelled', notes = concat_ws(E'\n', notes, 'Cancelled: ' || p_reason) where id = i.id;
  v_vars := public.interview_email_vars(i.id) || jsonb_build_object('reason', coalesce(p_reason, ''));
  perform public.enqueue_email(i.company_id, 'interview_cancelled', ctx.candidate_email, ctx.candidate_name, v_vars,
    'interview:' || i.id || ':cancelled', 'interviews', i.id)
  from public.application_context(i.application_id) ctx;
end $$;

create or replace function public.set_interview_status(p_interview uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare i public.interviews;
begin
  select * into i from public.interviews where id = p_interview;
  if i.id is null then raise exception 'Interview not found'; end if;
  perform public.require_permission(i.company_id, 'interviews.manage');
  if p_status not in ('completed','no_show','scheduled') then raise exception 'Invalid status'; end if;
  if i.status = 'cancelled' then raise exception 'Cancelled interviews cannot be changed'; end if;
  update public.interviews set status = p_status where id = i.id;
end $$;

create or replace function public.submit_interview_feedback(p_interview uuid, p_overall integer, p_technical integer,
  p_communication integer, p_culture integer, p_recommendation text, p_strengths text, p_weaknesses text, p_comments text)
returns uuid language plpgsql security definer set search_path = public as $$
declare i public.interviews; v_id uuid; ctx record;
begin
  select * into i from public.interviews where id = p_interview;
  if i.id is null then raise exception 'Interview not found'; end if;
  if not exists (select 1 from public.interview_panelists where interview_id = i.id and user_id = auth.uid())
     and not public.has_permission(i.company_id, 'interviews.manage') then
    raise exception 'Only panel members can submit feedback for this interview' using errcode = '42501';
  end if;
  if i.status = 'cancelled' then raise exception 'Cannot submit feedback for a cancelled interview'; end if;
  if i.scheduled_at > now() + interval '15 minutes' then raise exception 'Feedback can be submitted once the interview has started'; end if;
  if p_overall is null or p_overall not between 1 and 5 then raise exception 'Overall rating must be between 1 and 5'; end if;
  if p_recommendation not in ('strong_hire','hire','no_hire','strong_no_hire') then raise exception 'Select a recommendation'; end if;

  insert into public.interview_feedback (company_id, interview_id, interviewer_id, overall_rating, technical_rating,
    communication_rating, culture_rating, recommendation, strengths, weaknesses, comments)
  values (i.company_id, i.id, auth.uid(), p_overall, p_technical, p_communication, p_culture, p_recommendation,
    p_strengths, p_weaknesses, p_comments)
  on conflict (interview_id, interviewer_id) do update set overall_rating = excluded.overall_rating,
    technical_rating = excluded.technical_rating, communication_rating = excluded.communication_rating,
    culture_rating = excluded.culture_rating, recommendation = excluded.recommendation, strengths = excluded.strengths,
    weaknesses = excluded.weaknesses, comments = excluded.comments, submitted_at = now()
  returning id into v_id;

  if i.status = 'scheduled' then update public.interviews set status = 'completed' where id = i.id; end if;
  select * into ctx from public.application_context(i.application_id);
  perform public.notify_permission(i.company_id, 'candidates.manage', 'feedback', 'Interview feedback submitted',
    ctx.candidate_name || ' · ' || i.round_name || ' · ' || replace(p_recommendation, '_', ' '),
    '/app/recruitment/candidates/' || ctx.candidate_id);
  return v_id;
end $$;

-- ======================= OFFERS =========================
create or replace function public.offers_validate() returns trigger
language plpgsql security definer set search_path = public as $$
declare a public.applications;
begin
  select * into a from public.applications where id = new.application_id;
  if a.id is null or a.company_id <> new.company_id then raise exception 'Invalid application'; end if;
  new.candidate_id := a.candidate_id;
  new.job_id := a.job_id;
  if tg_op = 'INSERT' then
    if a.stage not in ('selected','offered','interview') then
      raise exception 'Offers can only be created for selected candidates (current stage: %)', a.stage;
    end if;
    new.status := 'draft';
    new.token_hash := null; new.pdf_path := null; new.sent_at := null;
  elsif old.status not in ('draft','rejected') and (
      new.ctc_annual is distinct from old.ctc_annual or new.joining_date is distinct from old.joining_date
      or new.basic_monthly is distinct from old.basic_monthly or new.hra_monthly is distinct from old.hra_monthly
      or new.allowances_monthly is distinct from old.allowances_monthly or new.designation_id is distinct from old.designation_id) then
    -- protect approved/sent offers from silent edits (status changes go through RPCs)
    if current_setting('hrms.offer_rpc', true) is distinct from 'on' then
      raise exception 'Offer terms can only be edited while the offer is a draft or rejected';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status and current_setting('hrms.offer_rpc', true) is distinct from 'on' then
    raise exception 'Offer status changes must use the offer workflow';
  end if;
  if new.joining_date < current_date and (tg_op = 'INSERT' or new.joining_date is distinct from old.joining_date) then
    raise exception 'Joining date cannot be in the past';
  end if;
  if new.expiry_date < current_date and (tg_op = 'INSERT' or new.expiry_date is distinct from old.expiry_date) then
    raise exception 'Offer expiry date cannot be in the past';
  end if;
  return new;
end $$;
create trigger trg_offers_validate before insert or update on public.offers
  for each row execute function public.offers_validate();

create or replace function public.submit_offer_for_approval(p_offer uuid, p_comments text default null)
returns text language plpgsql security definer set search_path = public as $$
declare o public.offers; v_required boolean; v_status text; ctx record;
begin
  select * into o from public.offers where id = p_offer;
  if o.id is null then raise exception 'Offer not found'; end if;
  perform public.require_permission(o.company_id, 'offers.manage');
  if o.status not in ('draft','rejected') then raise exception 'Only draft or rejected offers can be submitted'; end if;
  select offer_approval_required into v_required from public.companies where id = o.company_id;
  v_status := case when v_required then 'pending_approval' else 'approved' end;
  perform set_config('hrms.offer_rpc', 'on', true);
  update public.offers set status = v_status,
    approved_by = case when v_required then null else auth.uid() end,
    approved_at = case when v_required then null else now() end
  where id = o.id;
  perform set_config('hrms.offer_rpc', '', true);
  insert into public.offer_approvals (company_id, offer_id, action, comments) values (o.company_id, o.id, 'submitted', p_comments);
  if v_required then
    select * into ctx from public.application_context(o.application_id);
    perform public.notify_permission(o.company_id, 'offers.approve', 'approval', 'Offer awaiting approval',
      ctx.candidate_name || ' · ' || ctx.job_title || ' · ' || public.fmt_money(o.ctc_annual, null), '/app/offers/' || o.id);
  end if;
  return v_status;
end $$;

create or replace function public.decide_offer(p_offer uuid, p_approve boolean, p_comments text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o public.offers; v_admin boolean;
begin
  select * into o from public.offers where id = p_offer;
  if o.id is null then raise exception 'Offer not found'; end if;
  perform public.require_permission(o.company_id, 'offers.approve');
  if o.status <> 'pending_approval' then raise exception 'This offer is not awaiting approval'; end if;
  select r.is_admin into v_admin from public.company_members m join public.roles r on r.id = m.role_id
    where m.company_id = o.company_id and m.user_id = auth.uid();
  if o.created_by = auth.uid() and not coalesce(v_admin, false) and not public.is_super_admin() then
    raise exception 'You cannot approve an offer you created';
  end if;
  if not p_approve and char_length(coalesce(trim(p_comments), '')) < 3 then raise exception 'Please add a comment explaining the rejection'; end if;
  perform set_config('hrms.offer_rpc', 'on', true);
  update public.offers set status = case when p_approve then 'approved' else 'rejected' end,
    approved_by = case when p_approve then auth.uid() end, approved_at = case when p_approve then now() end
  where id = o.id;
  perform set_config('hrms.offer_rpc', '', true);
  insert into public.offer_approvals (company_id, offer_id, action, comments)
  values (o.company_id, o.id, case when p_approve then 'approved' else 'rejected' end, p_comments);
  perform public.notify_user(o.company_id, o.created_by, 'approval',
    case when p_approve then 'Offer approved' else 'Offer rejected' end, coalesce(p_comments, ''), '/app/offers/' || o.id);
end $$;

-- Generates a fresh secure token, marks the offer as sent and queues the email with the PDF attached.
create or replace function public.send_offer(p_offer uuid, p_base_url text, p_pdf_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.offers; ctx record; c public.companies;
  v_token text; v_link text; v_sends integer;
begin
  select * into o from public.offers where id = p_offer;
  if o.id is null then raise exception 'Offer not found'; end if;
  perform public.require_permission(o.company_id, 'offers.manage');
  if o.status not in ('approved','sent') then raise exception 'Offer must be approved before it can be sent'; end if;
  if o.expiry_date < current_date then raise exception 'Offer expiry date has passed. Edit the offer and resubmit.'; end if;
  if p_pdf_path is null or p_pdf_path not like o.company_id::text || '/offers/%' then raise exception 'Offer PDF is missing'; end if;
  if coalesce(p_base_url, '') !~ '^https?://' then raise exception 'A valid application URL is required for the offer link'; end if;
  select * into c from public.companies where id = o.company_id;
  select * into ctx from public.application_context(o.application_id);

  -- 256 bits of randomness from two v4 UUIDs (portable: no pgcrypto required); only the SHA-256 hash is stored
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_link := rtrim(p_base_url, '/') || '/offer/' || v_token;
  select count(*) into v_sends from public.offer_approvals where offer_id = o.id and action = 'sent';

  perform set_config('hrms.offer_rpc', 'on', true);
  update public.offers set status = 'sent', pdf_path = p_pdf_path,
    token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    token_expires_at = (o.expiry_date + 1)::timestamp at time zone c.timezone,
    sent_at = now(), viewed_at = null
  where id = o.id;
  perform set_config('hrms.offer_rpc', '', true);
  insert into public.offer_approvals (company_id, offer_id, action) values (o.company_id, o.id, 'sent');

  if (select stage from public.applications where id = o.application_id) <> 'offered' then
    perform set_config('hrms.stage_note', 'Offer ' || o.offer_number || ' sent', true);
    update public.applications set stage = 'offered' where id = o.application_id;
  end if;

  perform public.enqueue_email(o.company_id, 'offer_letter', ctx.candidate_email, ctx.candidate_name,
    jsonb_build_object('candidate_name', ctx.candidate_name, 'job_title', ctx.job_title,
      'ctc', public.fmt_money(o.ctc_annual, c.currency), 'joining_date', public.fmt_date(o.joining_date),
      'expiry_date', public.fmt_date(o.expiry_date), 'offer_link', v_link),
    'offer:' || o.id || ':sent:' || (v_sends + 1), 'offers', o.id,
    jsonb_build_array(jsonb_build_object('bucket', 'documents', 'path', p_pdf_path,
      'filename', 'Offer-Letter-' || o.offer_number || '.pdf')));
  return jsonb_build_object('offer_link', v_link, 'expires_at', o.expiry_date);
end $$;

create or replace function public.withdraw_offer(p_offer uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare o public.offers;
begin
  select * into o from public.offers where id = p_offer;
  if o.id is null then raise exception 'Offer not found'; end if;
  perform public.require_permission(o.company_id, 'offers.manage');
  if o.status in ('accepted','declined','withdrawn','expired') then raise exception 'This offer can no longer be withdrawn'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'Please provide a reason'; end if;
  perform set_config('hrms.offer_rpc', 'on', true);
  update public.offers set status = 'withdrawn', token_hash = null where id = o.id;
  perform set_config('hrms.offer_rpc', '', true);
  insert into public.offer_approvals (company_id, offer_id, action, comments) values (o.company_id, o.id, 'withdrawn', p_reason);
  update public.applications set stage = 'selected' where id = o.application_id and stage = 'offered';
end $$;

create or replace function public.expire_offers() returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  perform set_config('hrms.offer_rpc', 'on', true);
  update public.offers set status = 'expired' where status = 'sent' and token_expires_at < now();
  get diagnostics v = row_count;
  perform set_config('hrms.offer_rpc', '', true);
  return v;
end $$;

-- public: fetch an offer by its secure token (candidate does not need an account)
create or replace function public.public_get_offer(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.offers; c public.companies; ctx record; v_hash text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Invalid or expired offer link'; end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into o from public.offers where token_hash = v_hash;
  if o.id is null then raise exception 'Invalid or expired offer link'; end if;
  if o.status = 'sent' and o.token_expires_at < now() then
    perform set_config('hrms.offer_rpc', 'on', true);
    update public.offers set status = 'expired' where id = o.id;
    perform set_config('hrms.offer_rpc', '', true);
    o.status := 'expired';
  elsif o.status = 'sent' and o.viewed_at is null then
    perform set_config('hrms.offer_rpc', 'on', true);
    update public.offers set viewed_at = now() where id = o.id;
    perform set_config('hrms.offer_rpc', '', true);
  end if;
  select * into c from public.companies where id = o.company_id;
  select * into ctx from public.application_context(o.application_id);
  return jsonb_build_object(
    'status', o.status, 'offer_number', o.offer_number, 'candidate_name', ctx.candidate_name, 'job_title', ctx.job_title,
    'designation', (select title from public.designations where id = o.designation_id),
    'department', (select name from public.departments where id = o.department_id),
    'reporting_manager', (select trim(first_name || ' ' || last_name) from public.employees where id = o.reporting_manager_id),
    'employment_type', o.employment_type, 'work_location', o.work_location,
    'ctc_annual', o.ctc_annual, 'basic_monthly', o.basic_monthly, 'hra_monthly', o.hra_monthly,
    'allowances_monthly', o.allowances_monthly, 'joining_date', o.joining_date, 'expiry_date', o.expiry_date,
    'probation_months', o.probation_months, 'additional_terms', o.additional_terms, 'created_at', o.created_at,
    'responded_at', o.responded_at, 'candidate_signature', o.candidate_signature,
    'company', jsonb_build_object('name', c.name, 'legal_name', c.legal_name, 'address', c.address, 'city', c.city,
      'state', c.state, 'country', c.country, 'postal_code', c.postal_code, 'email', c.email, 'phone', c.phone,
      'website', c.website, 'logo_url', c.logo_url, 'primary_color', c.primary_color, 'currency', c.currency));
end $$;

create or replace function public.public_respond_offer(p_token text, p_accept boolean, p_signature text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.offers; ctx record; v_hash text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Invalid or expired offer link'; end if;
  perform public.check_rate_limit('offer:respond', p_token, 10, interval '1 hour');
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into o from public.offers where token_hash = v_hash for update;
  if o.id is null then raise exception 'Invalid or expired offer link'; end if;
  if o.status <> 'sent' then raise exception 'This offer has already been %', o.status; end if;
  if o.token_expires_at < now() then raise exception 'This offer has expired. Please contact HR.'; end if;
  select * into ctx from public.application_context(o.application_id);
  if p_accept and (char_length(coalesce(trim(p_signature), '')) < 3
                   or lower(trim(p_signature)) <> lower(ctx.candidate_name)) then
    raise exception 'Please type your full name exactly as shown (%) to sign', ctx.candidate_name;
  end if;

  perform set_config('hrms.offer_rpc', 'on', true);
  update public.offers set status = case when p_accept then 'accepted' else 'declined' end,
    responded_at = now(), candidate_signature = case when p_accept then trim(p_signature) end,
    decline_reason = case when p_accept then null else left(p_reason, 1000) end
  where id = o.id;
  perform set_config('hrms.offer_rpc', '', true);
  -- record on behalf of the candidate (no auth user)
  insert into public.offer_approvals (company_id, offer_id, action, comments, actor_id)
  values (o.company_id, o.id, case when p_accept then 'accepted' else 'declined' end, p_reason, null);

  if p_accept then
    perform public.enqueue_email(o.company_id, 'offer_accepted', ctx.candidate_email, ctx.candidate_name,
      jsonb_build_object('candidate_name', ctx.candidate_name, 'job_title', ctx.job_title, 'joining_date', public.fmt_date(o.joining_date)),
      'offer:' || o.id || ':accepted', 'offers', o.id);
    perform public.notify_permission(o.company_id, 'onboarding.manage', 'offer', 'Offer accepted 🎉',
      ctx.candidate_name || ' accepted the offer for ' || ctx.job_title, '/app/onboarding');
  else
    perform set_config('hrms.stage_note', 'Offer declined by candidate', true);
    update public.applications set stage = 'withdrawn', rejection_reason = coalesce('Offer declined: ' || p_reason, 'Offer declined')
      where id = o.application_id;
    perform public.notify_permission(o.company_id, 'offers.manage', 'offer', 'Offer declined',
      ctx.candidate_name || ' declined the offer for ' || ctx.job_title, '/app/offers/' || o.id);
  end if;
  return jsonb_build_object('status', case when p_accept then 'accepted' else 'declined' end);
end $$;
grant execute on function public.public_get_offer(text) to anon, authenticated;
grant execute on function public.public_respond_offer(text, boolean, text, text) to anon, authenticated;

-- ======================= ONBOARDING =========================
create or replace function public.on_offer_accepted() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_onb uuid;
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    insert into public.onboardings (company_id, offer_id, candidate_id, application_id, joining_date, status)
    values (new.company_id, new.id, new.candidate_id, new.application_id, new.joining_date, 'pending')
    on conflict (offer_id) do nothing
    returning id into v_onb;
    if v_onb is not null then
      insert into public.onboarding_tasks (company_id, onboarding_id, title, description, category, due_date, sort_order)
      select new.company_id, v_onb, t.title, t.description, t.category, new.joining_date + t.due_offset_days, t.sort_order
      from public.onboarding_task_templates t where t.company_id = new.company_id and t.is_active;
    end if;
  end if;
  return new;
end $$;
create trigger trg_offers_accepted after update of status on public.offers
  for each row execute function public.on_offer_accepted();

create or replace function public.onboarding_task_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_completed and not old.is_completed then
    new.completed_at := now(); new.completed_by := auth.uid();
    update public.onboardings set status = 'in_progress' where id = new.onboarding_id and status = 'pending';
  elsif not new.is_completed then
    new.completed_at := null; new.completed_by := null;
  end if;
  return new;
end $$;
create trigger trg_onboarding_task_touch before update on public.onboarding_tasks
  for each row execute function public.onboarding_task_touch();

create or replace function public.confirm_joining(p_onboarding uuid, p_joining_date date)
returns void language plpgsql security definer set search_path = public as $$
declare ob public.onboardings; o public.offers; c public.companies; ctx record;
begin
  select * into ob from public.onboardings where id = p_onboarding;
  if ob.id is null then raise exception 'Onboarding not found'; end if;
  perform public.require_permission(ob.company_id, 'onboarding.manage');
  if ob.status in ('completed','cancelled') then raise exception 'Onboarding is already %', ob.status; end if;
  if p_joining_date is null or p_joining_date < current_date - 30 then raise exception 'Enter a valid joining date'; end if;
  select * into o from public.offers where id = ob.offer_id;
  select * into c from public.companies where id = ob.company_id;
  select * into ctx from public.application_context(ob.application_id);
  update public.onboardings set joining_confirmed = true, joining_confirmed_at = now(), joining_date = p_joining_date,
    status = case when status = 'pending' then 'in_progress' else status end
  where id = ob.id;
  perform public.enqueue_email(ob.company_id, 'joining_confirmation', ctx.candidate_email, ctx.candidate_name,
    jsonb_build_object('candidate_name', ctx.candidate_name, 'job_title', ctx.job_title,
      'joining_date', public.fmt_date(p_joining_date), 'work_location', coalesce(o.work_location, c.address, c.city, 'our office'),
      'reporting_time', to_char(c.work_start, 'HH12:MI AM')),
    'onboarding:' || ob.id || ':joining:' || p_joining_date, 'onboardings', ob.id);
end $$;

create or replace function public.complete_onboarding(p_onboarding uuid, p_base_url text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ob public.onboardings; o public.offers; cand public.candidates; j public.jobs; v_emp uuid; v_code text;
  v_hired integer;
begin
  select * into ob from public.onboardings where id = p_onboarding for update;
  if ob.id is null then raise exception 'Onboarding not found'; end if;
  perform public.require_permission(ob.company_id, 'onboarding.manage');
  if ob.status = 'completed' then raise exception 'Onboarding is already completed'; end if;
  if ob.status = 'cancelled' then raise exception 'Onboarding was cancelled'; end if;
  if not ob.joining_confirmed then raise exception 'Confirm the joining date before completing onboarding'; end if;
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

  -- initial leave balances for the current year (pro-rated by remaining months)
  insert into public.leave_balances (company_id, employee_id, leave_type_id, year, allocated)
  select ob.company_id, v_emp, lt.id, extract(year from ob.joining_date)::int,
         round(lt.annual_quota * (13 - extract(month from ob.joining_date)) / 12 * 2) / 2
  from public.leave_types lt where lt.company_id = ob.company_id and lt.is_active and lt.is_paid
  on conflict do nothing;

  -- close the job automatically once all openings are filled
  select count(*) into v_hired from public.applications where job_id = j.id and stage = 'hired';
  if v_hired >= j.openings and j.status = 'published' then
    update public.jobs set status = 'closed' where id = j.id;
  end if;

  perform public.enqueue_email(ob.company_id, 'welcome_employee', cand.email, trim(cand.first_name || ' ' || cand.last_name),
    jsonb_build_object('employee_name', trim(cand.first_name || ' ' || cand.last_name), 'employee_code', v_code,
      'joining_date', public.fmt_date(ob.joining_date),
      'login_link', coalesce(nullif(p_base_url, ''), '') || '/signup?email=' || cand.email),
    'onboarding:' || ob.id || ':welcome', 'employees', v_emp);
  perform public.notify_permission(ob.company_id, 'employees.manage', 'employee', 'New employee onboarded',
    trim(cand.first_name || ' ' || cand.last_name) || ' (' || v_code || ') joined', '/app/employees/' || v_emp);
  return v_emp;
end $$;

create or replace function public.cancel_onboarding(p_onboarding uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare ob public.onboardings;
begin
  select * into ob from public.onboardings where id = p_onboarding;
  if ob.id is null then raise exception 'Onboarding not found'; end if;
  perform public.require_permission(ob.company_id, 'onboarding.manage');
  if ob.status = 'completed' then raise exception 'Completed onboarding cannot be cancelled'; end if;
  update public.onboardings set status = 'cancelled', notes = concat_ws(E'\n', notes, 'Cancelled: ' || p_reason) where id = ob.id;
  perform set_config('hrms.stage_note', 'Onboarding cancelled: ' || coalesce(p_reason, ''), true);
  update public.applications set stage = 'withdrawn', rejection_reason = 'Did not join: ' || coalesce(p_reason, '')
    where id = ob.application_id;
end $$;
