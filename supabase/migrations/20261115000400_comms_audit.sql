-- =====================================================================
-- 0400  COMMUNICATIONS & AUDIT: email templates, email queue/logs,
--       notifications, audit logs
-- =====================================================================

create table public.email_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  key text not null check (key ~ '^[a-z_]{3,60}$'),
  name text not null,
  description text,
  subject text not null check (char_length(subject) between 3 and 250),
  body_html text not null check (char_length(body_html) between 10 and 50000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, key)
);
create trigger trg_email_templates_updated before update on public.email_templates
  for each row execute function public.set_updated_at();

create table public.email_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  template_key text not null,
  to_email text not null,
  to_name text,
  subject text not null,
  body_html text not null,
  attachments jsonb not null default '[]'::jsonb,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','skipped')),
  attempts integer not null default 0,
  last_error text,
  provider text,
  provider_message_id text,
  dedupe_key text not null,
  related_table text,
  related_id uuid,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, dedupe_key)
);
create index email_logs_company_idx on public.email_logs (company_id, created_at desc);
create index email_logs_queue_idx on public.email_logs (status, created_at) where status in ('queued','failed');
create trigger trg_email_logs_updated before update on public.email_logs
  for each row execute function public.set_updated_at();

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null default 'info',
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

create table public.audit_logs (
  id bigint generated always as identity primary key,
  company_id uuid, -- intentionally no FK: audit trail must survive deletion of its subject
  actor_id uuid,
  action text not null check (action in ('INSERT','UPDATE','DELETE')),
  table_name text not null,
  record_id uuid,
  old_data jsonb,
  new_data jsonb,
  changed_fields text[],
  created_at timestamptz not null default now()
);
create index audit_logs_company_idx on public.audit_logs (company_id, created_at desc);
create index audit_logs_record_idx on public.audit_logs (table_name, record_id);

-- ---------- template rendering ----------
create or replace function public.html_escape(p text) returns text
language sql immutable as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;

-- Replaces {{var}} placeholders. Values are HTML-escaped unless p_escape = false (subjects).
create or replace function public.render_template(p_text text, p_vars jsonb, p_escape boolean default true) returns text
language plpgsql immutable as $$
declare k text; v text; out text := p_text;
begin
  for k, v in select key, value from jsonb_each_text(coalesce(p_vars, '{}'::jsonb)) loop
    out := replace(out, '{{' || k || '}}', case when p_escape then public.html_escape(v) else coalesce(v, '') end);
  end loop;
  -- strip any unknown placeholders
  return regexp_replace(out, '\{\{[a-z_]+\}\}', '', 'g');
end $$;

-- Queue an email. Idempotent per (company, dedupe_key): duplicates are ignored.
-- Returns the email_logs id, or null when it was a duplicate.
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
    coalesce(public.render_template(t.body_html, v_vars, true), ''),
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

-- ---------- notifications ----------
create or replace function public.notify_user(p_company uuid, p_user uuid, p_type text, p_title text, p_body text, p_link text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (company_id, user_id, type, title, body, link)
  select p_company, p_user, p_type, p_title, p_body, p_link where p_user is not null
$$;

create or replace function public.notify_permission(p_company uuid, p_permission text, p_type text, p_title text, p_body text, p_link text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (company_id, user_id, type, title, body, link)
  select p_company, m.user_id, p_type, p_title, p_body, p_link
  from public.company_members m join public.roles r on r.id = m.role_id
  where m.company_id = p_company and m.status = 'active'
    and (r.is_admin or exists (select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission = p_permission))
    and m.user_id is distinct from auth.uid()
$$;
revoke execute on function public.notify_user(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_permission(uuid, text, text, text, text, text) from public, anon, authenticated;

-- ---------- audit ----------
create or replace function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb; v_new jsonb; v_changed text[]; v_company uuid; v_id uuid;
begin
  if tg_op in ('UPDATE','DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' then
    select array_agg(n.key) into v_changed
    from jsonb_each(v_new) n
    where n.key not in ('updated_at') and n.value is distinct from (v_old -> n.key);
    if v_changed is null then return new; end if;
  end if;
  -- never store secrets/tokens in the audit trail
  v_old := v_old - 'token_hash' - 'encrypted_password';
  v_new := v_new - 'token_hash' - 'encrypted_password';
  v_company := coalesce((coalesce(v_new, v_old) ->> 'company_id')::uuid,
                        case when tg_table_name = 'companies' then (coalesce(v_new, v_old) ->> 'id')::uuid end);
  v_id := public.try_uuid(coalesce(v_new, v_old) ->> 'id');
  insert into public.audit_logs (company_id, actor_id, action, table_name, record_id, old_data, new_data, changed_fields)
  values (v_company, auth.uid(), tg_op, tg_table_name, v_id, v_old, v_new, v_changed);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'companies','roles','company_members','company_invitations','departments','designations','employees',
    'holidays','leave_types','leave_balances','leave_requests','payroll_runs','job_requisitions','jobs',
    'candidates','applications','interviews','interview_feedback','offers','onboardings','email_templates',
    'onboarding_task_templates'
  ] loop
    execute format('create trigger trg_audit_%1$s after insert or update or delete on public.%1$I
                    for each row execute function public.audit_trigger()', t);
  end loop;
end $$;
