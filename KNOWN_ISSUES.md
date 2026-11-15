# Known issues & limitations

## Requires external configuration (not code defects)
1. **Real email delivery is not enabled.** The Edge Function runs with `EMAIL_MODE=mock`; no Resend key/verified domain
   was provided. Emails are rendered, queued, deduplicated and marked `sent` with provider `mock`. Set `EMAIL_MODE=resend`,
   `RESEND_API_KEY`, `EMAIL_FROM` to deliver (optionally `EMAIL_TEST_RECIPIENT` for UAT).
2. **Supabase Auth emails** (signup confirmation, password reset) use Supabase's built-in mailer, which is rate-limited.
   Configure custom SMTP before production.
3. **No public deployment** was performed (not authorized). Auth Site URL is `http://localhost:5173`.
4. **Security housekeeping:** the Supabase personal access token used during setup was shared in chat — revoke it.

## Functional gaps vs. the full specification
| Area | Gap |
|---|---|
| Attendance | No late-arrival / early-departure flags and no employee-initiated correction-request approval flow (HR edits records directly; half-day is automatic under 4 h). |
| Interviews | No automatic interview reminder emails (would need a scheduled job, e.g. Supabase Cron). |
| Offers | One branded offer-letter layout with editable terms; no multiple offer templates. |
| Careers | Per-company URLs (`/careers/:slug`) instead of a global `/careers`; no education fields or reference number on the success page (the application id is stored). |
| Recruitment | No bulk actions on candidates. |
| Leave | No team leave calendar view (list + approvals only). |
| Reports | CSV export + browser print-to-PDF; no server-generated PDF reports. |
| Communication | Group image is supported in the data model/RPC but has no upload UI; presence is heartbeat-based (online = active within 75 s). |
| UI | No dark mode. Custom component library (Tailwind) instead of shadcn/ui; custom calendar instead of FullCalendar. |
| Payroll | Simplified statutory model (configurable PF %, flat professional tax, flat TDS %); not a substitute for jurisdiction-specific tax computation. |

## Demo mode
- Data lives in the browser (IndexedDB). It is not a security boundary and is per-browser.
- Each tab runs its own in-memory database loaded from IndexedDB; **open the demo in a single tab** (multi-tab and
  realtime between users are verified in Supabase mode instead). First launch takes ~10 s to create and seed the database.
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
