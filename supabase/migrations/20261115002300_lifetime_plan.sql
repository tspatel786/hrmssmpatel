-- =====================================================================
-- 2300  LIFETIME PLAN
-- A permanent licence with no trial and no expiry. The internal HRMS company is set to it.
-- Only the platform administrator can change a company's plan (guard_companies, unchanged).
-- Additive: the plan check gains one value; no table dropped, no data deleted.
-- =====================================================================
do $$
declare v_con text;
begin
  select conname into v_con from pg_constraint
  where conrelid = 'public.companies'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%plan%';
  if v_con is not null then execute format('alter table public.companies drop constraint %I', v_con); end if;
  alter table public.companies add constraint companies_plan_check
    check (plan in ('trial','starter','growth','enterprise','lifetime'));
end $$;
