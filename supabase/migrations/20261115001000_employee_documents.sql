-- =====================================================================
-- 1000  EMPLOYEE DOCUMENTS (metadata; bytes live in the private
--       documents bucket under <company_id>/employees/<employee_id>/)
-- =====================================================================
create table public.employee_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  doc_type text not null default 'other' check (doc_type in ('id_proof','address_proof','education','experience','contract','offer_letter','tax','other')),
  file_name text not null check (char_length(file_name) between 1 and 200),
  storage_path text not null,
  mime_type text,
  size_bytes bigint check (size_bytes between 0 and 10485760),
  uploaded_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (storage_path like company_id::text || '/employees/' || employee_id::text || '/%')
);
create index employee_documents_idx on public.employee_documents (employee_id, created_at desc);
alter table public.employee_documents enable row level security;

create trigger trg_same_company before insert or update on public.employee_documents for each row
  execute function public.guard_same_company('employee_id:employees');
create trigger trg_audit_employee_documents after insert or update or delete on public.employee_documents
  for each row execute function public.audit_trigger();

create policy "read employee documents" on public.employee_documents for select to authenticated using (
  public.has_permission(company_id, 'employees.view') or employee_id = public.my_employee_id(company_id));
create policy "employee managers write documents" on public.employee_documents for all to authenticated
  using (public.has_permission(company_id, 'employees.manage')) with check (public.has_permission(company_id, 'employees.manage'));
revoke all on public.employee_documents from anon;
