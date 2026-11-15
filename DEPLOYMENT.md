# Deployment

> No public deployment has been performed. These are the steps to deploy when authorized.

## 1. Database
```bash
export SUPABASE_ACCESS_TOKEN=...   # personal access token (do not commit)
export SUPABASE_PROJECT_REF=...    # target project
npm run db:apply                   # applies pending supabase/migrations/*.sql, records them in supabase_migrations
```
(Equivalent: `npx supabase link --project-ref $SUPABASE_PROJECT_REF && npx supabase db push`.)
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

## Readiness checklist
- [x] Migrations applied and verified on a fresh project
- [x] RLS on every table, live isolation tests passing
- [x] Edge Function deployed (mock mode)
- [ ] Email provider (Resend) key + verified domain
- [ ] Custom auth SMTP and production Site URL
- [ ] Production hosting + domain
