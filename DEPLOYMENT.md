# Deployment

> No public deployment has been performed. These are the steps to deploy when authorized.

## 0. Upgrading an existing project to migrations 1200 / 1300 / 1400 — ORDER MATTERS

On a project that already has migrations up to 1100 applied, **do not run `npm run db:apply` or `supabase db push`**:
both apply every pending migration at once, before the new frontend is live. Migration 1200 unpublishes three chat
tables, and the old frontend (one Realtime channel for all chat tables) then receives **no realtime events at all**.

1. **Deploy the new frontend first** (section 4). It works with both the pre- and post-migration schemas (verified
   live: per-table Realtime channels; settings/offer fields from 1300/1400 are hidden until their columns exist).
   Confirm the deployed build is the new one before continuing (e.g. the Communication page opens with no console
   errors, and Settings → HR policies saves without a `late_grace_minutes` error).
2. Back up the database (Dashboard → Database → Backups, or `pg_dump`; see `MIGRATION_1200_RUNBOOK.md`).
3. Apply migrations **one at a time**, verifying after each:
   ```bash
   node scripts/supabase-apply.mjs --dry-run              # expected: would apply 1200, 1300, 1400
   node scripts/supabase-apply.mjs --only 20261115001200   # then run the 1200 verification + acceptance test
   node scripts/supabase-apply.mjs --only 20261115001300
   node scripts/supabase-apply.mjs --only 20261115001400
   node scripts/supabase-apply.mjs --only 20261115001500   # role dashboards; then: npx vitest run tests/supabase/roles_1500.test.ts (SUPABASE_LIVE=1)
   node scripts/supabase-apply.mjs --only 20261115001600   # invitation email subject names S.M.PATEL HRMS (customised subjects untouched)
   node scripts/supabase-apply.mjs --only 20261115001700   # public sign-up switch (default open = SaaS product)
   node scripts/supabase-apply.mjs --only 20261115001800   # company deletion fix
   # internal HRMS only (one organisation, invitation only):
   #   update public.platform_settings set public_signup = false, updated_at = now();
   ```
   Status 2026-11-22: 1200-1900 are all applied to the live project; public_signup = false (internal HRMS: invitation only);
   app_url = https://connect.smpatelithub.in; edge function employee-auth deployed (`npx supabase functions deploy employee-auth`).
   Migrations up to 2400 applied (22 Nov). Scheduled in Supabase (pg_cron): `hrms-daily-jobs` hourly at :07
   (`select public.run_daily_jobs()`), `hrms-send-emails` every 5 min (pg_net POST to the process-emails function with the
   public anon key), `hrms-interview-reminders` every 15 min. Auth: passwords min 8 characters with letters and digits.
4. Run the live tests (`npm run test:live`, `SUPABASE_LIVE=1 npx playwright test --project=supabase`).

Rollback for this upgrade: see section 6. **Never roll the frontend back to a pre-1200 build while migration 1200 is
applied** without first restoring the publication (section 6), or chat realtime stops silently.

## 1. Database (fresh project only)
```bash
export SUPABASE_ACCESS_TOKEN=...   # personal access token (do not commit)
export SUPABASE_PROJECT_REF=...    # target project
npm run db:apply                   # applies ALL pending supabase/migrations/*.sql, records them in supabase_migrations
```
(Equivalent: `npx supabase link --project-ref $SUPABASE_PROJECT_REF && npx supabase db push`.)
Use this only for a brand-new, empty project with no deployed frontend. For an existing project, follow section 0.
Never apply `supabase/local/shim.sql` to Supabase.

## 2. Edge Function + secrets
```bash
npx supabase functions deploy process-emails --project-ref $SUPABASE_PROJECT_REF --use-api
npx supabase secrets set EMAIL_MODE=resend RESEND_API_KEY=... EMAIL_FROM="HRMS <no-reply@yourdomain.com>" --project-ref $SUPABASE_PROJECT_REF
```
Optional reliability: schedule the worker every minute (Dashboard → Integrations → Cron → HTTP request to
`/functions/v1/process-emails` with the service key), in addition to the app invoking it after each action.

## 3. Auth settings
Set Site URL and redirect allow-list to the production domain (Dashboard → Auth → URL configuration, or Management API
`PATCH /v1/projects/{ref}/config/auth`). Configure custom SMTP for auth emails (Supabase's built-in mailer is rate-limited).

## 4. Frontend (Vercel or any static host)
- Build command: `npm run build`; output: `dist`; framework: Vite.
- Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PUBLIC_APP_URL=https://your-domain`.
- SPA fallback: rewrite all routes to `/index.html` (Vercel: `vercel.json` included).

## 5. First platform admin
```sql
insert into public.platform_admins (user_id) select id from auth.users where email = 'you@company.com';
```

## 6. Rollback

Frontend and database roll back in a fixed order because the pre-1200 frontend cannot receive realtime events from a
post-1200 database.

| Situation | Action |
|---|---|
| New frontend misbehaves, **no migration applied yet** | Redeploy the previous frontend build (Vercel: Deployments → previous → *Promote to Production*; other hosts: redeploy the previous commit). No database change needed. |
| Migration 1200 applied, new frontend fine, 1200 causes a problem | Run the SQL rollback in `MIGRATION_1200_RUNBOOK.md` (re-publishes the old tables; **re-opens the leak**). Keep the new frontend: it works on both. |
| Migration 1200 applied **and** the frontend must go back to a pre-1200 build | **First** run the 1200 SQL rollback, **then** redeploy the old frontend. Doing it the other way round stops chat realtime silently. |
| Migration 1300 / 1400 causes a problem | Keep the new frontend (it hides 1300/1400 fields when the columns are missing, but the new pages — attendance corrections, leave calendar, offer templates, bulk actions — need the migration). Restore from the backup taken before the migration for a full revert; these migrations add tables/columns/functions only and drop no data. |

Before any rollback, note the exact commit of the frontend build being replaced so you can roll forward again.

## Readiness checklist
- [x] Migrations applied and verified on a fresh project
- [x] RLS on every table, live isolation tests passing
- [x] Edge Function deployed (mock mode)
- [ ] Email provider (Resend) key + verified domain
- [ ] Custom auth SMTP and production Site URL
- [ ] Production hosting + domain
