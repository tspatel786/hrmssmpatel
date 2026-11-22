-- =====================================================================
-- 2600  DESIGNATIONS BELONG TO DEPARTMENTS
-- Forms now show only the designations of the selected department (plus general ones without a department).
-- The default designations were created without a department, so every list showed everything.
-- A. New designations with a well-known title and no department are linked to the matching department of the
--    same company (when it exists). HR can still change or clear it on the Organization page.
-- B. Existing unlinked designations with those titles are linked the same way.
-- No table dropped, no data deleted, no policy changed.
-- =====================================================================
create or replace function public.default_department_for(p_company uuid, p_title text) returns uuid
language sql stable security definer set search_path = public as $$
  select d.id from public.departments d
  where d.company_id = p_company and d.name = case
    when p_title in ('Software Engineer','Senior Software Engineer','Engineering Manager','Data Analyst','Tech Lead','QA Engineer') then 'Engineering'
    when p_title in ('HR Executive','HR Manager','Recruiter') then 'Human Resources'
    when p_title in ('Sales Executive','Sales Manager','Business Development Executive') then 'Sales'
    when p_title in ('Accountant','Finance Manager','Payroll Executive') then 'Finance'
    when p_title in ('Operations Executive','Operations Manager','Office Administrator') then 'Operations'
    when p_title in ('Product Designer','UI/UX Designer') then 'Design'
  end
  limit 1
$$;
revoke execute on function public.default_department_for(uuid, text) from public, anon, authenticated;

create or replace function public.designation_default_department() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.department_id is null then new.department_id := public.default_department_for(new.company_id, new.title); end if;
  return new;
end $$;
drop trigger if exists trg_designation_default_department on public.designations;
create trigger trg_designation_default_department before insert on public.designations
  for each row execute function public.designation_default_department();

update public.designations g set department_id = public.default_department_for(g.company_id, g.title)
where g.department_id is null and public.default_department_for(g.company_id, g.title) is not null;
