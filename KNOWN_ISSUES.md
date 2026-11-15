# Known issues & limitations

## Requires external configuration (not code defects)
1. **Real email delivery is not enabled.** The Edge Function runs with `EMAIL_MODE=mock`; no Resend key/verified domain
   was provided. Emails are rendered, queued, deduplicated and marked `sent` with provider `mock`. Set `EMAIL_MODE=resend`,
   `RESEND_API_KEY`, `EMAIL_FROM` to deliver (optionally `EMAIL_TEST_RECIPIENT` for UAT).
2. **Supabase Auth emails** (signup confirmation, password reset) use Supabase's built-in mailer, which is rate-limited.
   Configure custom SMTP before production.
3. **No public deployment** was performed (not authorized). Auth Site URL is `http://localhost:5173`.
4. **Security housekeeping:** the Supabase personal access token used during setup was shared in chat — revoke it.

5. **SECURITY — open in the live project:** Supabase Realtime broadcasts primary keys of deleted rows to every subscriber
   (all companies) for `chat_typing_status`, `chat_reactions`, `chat_participants`, `announcements` — verified live; no content
   leaks, but conversation membership does. Fixed by migration 1200, which is **not applied**. Follow `MIGRATION_1200_RUNBOOK.md`
   (deploy the new frontend first, then `node scripts/supabase-apply.mjs --only 20261115001200`, then `npm run test:live`).
   Do not consider it fixed until `tests/supabase/realtime.test.ts` passes 4/4.
6. **Migrations 1200–1400 are not yet applied to the Supabase project** (no management token available; schema changes
   need your authorization). Apply with `SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... npm run db:apply`, then run
   `npm run test:live`. Until then the live project lacks: the Realtime isolation fix (verified cross-company metadata leak
   via DELETE events — `tests/supabase/realtime.test.ts` fails until applied), the chat storage path check, attendance
   flags/corrections, team leave calendar, bulk actions, interview reminders, offer templates and careers education fields.
   The frontend degrades gracefully on the old schema for chat, attendance flags and offers; the new screens (corrections,
   team calendar, offer templates, bulk actions) show an error until the migrations are applied.
7. **Edge Function redeploy needed for interview reminders on Supabase:** `process-emails` now calls
   `send_interview_reminders()` each run. Redeploy it (`supabase functions deploy process-emails`), and/or enable the
   `pg_cron` extension before applying migration 1400 so reminders are scheduled every 15 minutes in the database.

## Functional gaps vs. the full specification
| Area | Gap |
|---|---|
| Careers | Careers sites are per company (`/careers/:slug`) by design for multi-tenancy; there is no cross-company `/careers` index. |
| Reports | PDF export is generated in the browser (jsPDF), not on a server. |
| Communication | Presence is heartbeat-based (online = heartbeat within 75 s, 30 s refresh) rather than Supabase Presence channels; browser notifications need an open HRMS tab (no service-worker push); `announcements` deletes still broadcast the announcement id to all Realtime subscribers (no content). |
| Dark mode | Implemented as a palette remap of the light utility classes (`src/styles/dark.css`, generated); charts and the email-preview iframe keep light colours. Light remains the default. |
| UI | Custom component library (Tailwind) instead of shadcn/ui; custom calendar instead of FullCalendar. |
| Payroll | Simplified statutory model (configurable PF %, flat professional tax, flat TDS %); not a substitute for jurisdiction-specific tax computation. |
| Bulk actions | Selection is per table page (up to 200 applications / 500 candidates per action). |

Closed on 2026-11-15: attendance late/early flags + correction requests, interview reminder emails, multiple offer
templates, careers education fields + reference number, candidate bulk actions, team leave calendar, PDF report export,
dark mode, group photo upload in chat.

## Demo mode
- Data lives in the browser (IndexedDB). It is not a security boundary and is per-browser.
- Each tab runs its own in-memory database loaded from IndexedDB; **open the demo in a single tab** (multi-tab and
  realtime between users are verified in Supabase mode instead). First launch takes ~50 s on a typical laptop to create and seed the database (measured in headless Chromium).
- Password reset is unavailable in demo mode (no email).

## Tooling
- **Dependency advisories (runtime, `npm audit --omit=dev`):** jsPDF/DOMPurify (critical/high), supabase auth-js (low) and the
  patchable React Router issues were fixed by upgrading (jsPDF 4.2.1, supabase-js 2.109, react-router-dom 6.30.6). Remaining:
  - `react-router` *moderate* — open redirect via backslash paths: **mitigated in code** (`safeNext()` only accepts single-slash
    same-origin paths; unit-tested). The SSR-hydration advisory does not apply to this SPA. Full fix requires React Router 7 (major).
  - `zod` *high* — memory exhaustion on oversized constrained collections: zod validates only the user's own form input in
    their browser (self-DoS at worst); server-side validation is done in Postgres. Accepted until a zod 4 migration.
  - Remaining dev-only advisories are in build/test tooling and are not shipped in the bundle.
- supabase-js ≥ 2.10x needs a WebSocket implementation on Node 20; Node-side test clients pass `ws` as the realtime transport.
- Bundle: the PGlite WASM (~15 MB) is emitted in `dist/` but only downloaded in demo mode.
