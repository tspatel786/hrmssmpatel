-- =====================================================================
-- 1800  COMPANY DELETION FIX
-- signal_announcements (migration 1200) bumps company_realtime_signals on every announcement change. When a
-- company is deleted, its announcements are removed by the cascade and the trigger inserted a signal row for the
-- company that no longer exists -> foreign-key violation -> the whole company delete was rolled back.
-- Effect before this fix: no company that ever had an announcement could be deleted (platform admin or cleanup).
-- Now the signal is skipped when the company is gone (nobody is left to notify). Same behaviour otherwise.
-- No table is dropped, no data is deleted, no policy is changed.
-- =====================================================================
create or replace function public.signal_announcements() returns trigger
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if tg_op = 'DELETE' then v := old.company_id; else v := new.company_id; end if;
  if not exists (select 1 from public.companies where id = v) then return null; end if; -- company being deleted
  insert into public.company_realtime_signals (company_id, announcements_at) values (v, now())
  on conflict (company_id) do update set announcements_at = now();
  return null;
end $$;
