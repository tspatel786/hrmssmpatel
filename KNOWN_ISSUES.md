# Known issues & limitations

## Requires external configuration (not code defects)
1. **Email delivery is owner-managed.** In the final audit (2026-11-15) the deployed `process-emails` function reported
   `EMAIL_MODE=resend` (a real provider). Delivery itself was not tested from this repository (handled by the project owner).
   The live test that invokes the worker now runs only with `LIVE_EMAIL_MODE=mock`, so test runs never mail throwaway addresses.
2. **Supabase Auth emails** (signup confirmation, password reset) use Supabase's built-in mailer, which is rate-limited.
   Configure custom SMTP before production.
3. **Production frontend:** `main` is deployed on Render (per the project owner). The last documented Auth Site URL was
   `http://localhost:5173`; set it and the redirect allow-list to the production domain.
4. **Security housekeeping:** the Supabase personal access token used during setup was shared in chat — revoke it.

5. **SECURITY — fixed (final audit 2026-11-15):** Supabase Realtime broadcast primary keys of deleted rows to every subscriber
   for `chat_typing_status`, `chat_reactions`, `chat_participants`, `announcements`. Migration 1200 is now applied to the live
   project and `tests/supabase/realtime.test.ts` passes 4/4. Residual: rows of the four published tables are still deleted by
   `ON DELETE CASCADE` when a whole company or user account is deleted, broadcasting their keys once.
6. **Migrations 1200–1400 are applied to the Supabase project** (by the project owner; verified read-only in the final audit,
   2026-11-15). Whether the new frontend was deployed before them could not be verified from here (no deployment was made
   from this repository; see `FINAL_PRODUCTION_READINESS_REPORT.md`).
7. **Edge Function redeploy needed for interview reminders on Supabase:** `process-emails` now calls
   `send_interview_reminders()` each run. Redeploy it (`supabase functions deploy process-emails`), and/or enable the
   `pg_cron` extension before applying migration 1400 so reminders are scheduled every 15 minutes in the database.

## Functional gaps vs. the full specification
| Area | Gap |
|---|---|
| Careers | Careers sites are per company (`/careers/:slug`) by design for multi-tenancy; there is no cross-company `/careers` index. |
| Reports | PDF export is generated in the browser (jsPDF), not on a server. |
| Communication | Presence is heartbeat-based (online = heartbeat within 75 s, 30 s refresh) rather than Supabase Presence channels; browser notifications need an open HRMS tab (no service-worker push). Since migration 1200, `announcements` is no longer published (changes are signalled through RLS-checked `company_realtime_signals`). |
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

## Testing environment
- **Demo E2E (final audit 2026-11-15, idle machine):** desktop + mobile + tablet all pass. The intermittent CI failure was a
  test bug (an ambiguous "Applicants" heading match on jobs without applicants), fixed in `e2e/gaps.spec.ts`.
- **First demo launch blocks the page:** seeding the in-browser database runs on the main thread, so the tab is unresponsive
  for up to about a minute on the first visit (seen in Chrome). Later visits load from IndexedDB quickly.

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
