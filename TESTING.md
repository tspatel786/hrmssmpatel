# Testing

## Layers

| Layer | Command | What it covers |
|---|---|---|
| Static | `npm run typecheck`, `npm run lint` | TypeScript strict mode, ESLint (react-hooks, no unused) — zero warnings policy |
| Unit | `npx vitest run tests/unit` | Open-redirect guard, CSV formula-injection escaping, amount-in-words |
| Database (PGlite) | `npx vitest run tests/db` | The **real migrations** in Postgres 18 WASM through the same adapter the app uses, with RLS enforced per call |
| Live Supabase | `npm run test:live` | Real Auth + PostgREST + Storage RLS + deployed Edge Function on the configured project (opt-in, self-cleaning) |
| E2E (demo) | `npm run test:e2e` | Playwright against the demo build: full hiring lifecycle through the UI, roles, navigation; layout at desktop, mobile (Pixel 7) and tablet (768 × 1024). CI: `--project=desktop --project=mobile --project=tablet` |
| Live Realtime | `SUPABASE_LIVE=1 npx vitest run tests/supabase/realtime.test.ts` | Websocket delivery to participants, typing/receipt/reaction propagation, no cross-company payloads (incl. DELETE events) |
| E2E (Supabase) | `SUPABASE_LIVE=1 npx playwright test --project=supabase` | Multiple browser contexts, real Realtime: DMs, groups (+photo), sound, browser notifications, receipts, typing, presence, reactions, pins, files, search, mute, multi-tab dedupe, announcements, mobile chat layout, UI isolation |

## Database suites (`tests/db`)
- `lifecycle.test.ts` — company → HR user → job → public application with resume → shortlist (single email despite
  revisits) → interview (+ conflict detection) → feedback → selection → offer → approval → send (PDF attachment, hashed
  token) → email worker → anonymous acceptance → onboarding → employee → dashboard/audit.
- `security.test.ts` — 14-table cross-tenant isolation, cross-tenant writes/RPCs/FK references, role permissions,
  employee self-service, plan/status guards, last-admin & system-role protection, suspended companies, anonymous API
  restrictions, input validation, rate limiting, storage policies, offer token expiry, audit redaction, requisition rules.
- `hr.test.ts` — employee codes, unique emails, plan limits, clock in/out, manual attendance, manager visibility,
  working-day leave calculation with holidays, overlap/balance rules, approvals & cancellations, carry-forward,
  payroll with LOP (exact amounts), payslip visibility, locking, dashboards, reports, test emails, notifications.
- `communication.test.ts` — DM dedupe, same-company rule, idempotent sends, unread counts, read receipts, participant-only
  access, blocked direct writes, own-message edit/delete, reactions, pins, replies, groups & admin rules, admin
  promotion, mute, attachments & storage policies, presence/typing visibility, announcements (permissions, targeting, acks).
- `seed.test.ts` — the demo seed runs end-to-end through the real RPCs.
- `hr_gaps.test.ts` — late/early flags (time zone, grace, leave days), correction requests (validation, visibility,
  manager/HR approval, no self-approval, cancel/reject), team leave calendar scoping (HR vs department vs other companies).
- `recruitment_gaps.test.ts` — careers education + reference number, bulk stage/reject with per-item failures, bulk tags,
  interview reminders (once per scheduled time, re-armed on reschedule, service-role only), offer templates (default,
  permissions, same-company enforcement).

- `isolation_catalog.test.ts` — catalog-wide audit: RLS on **every** public table, every view `security_invoker`, an admin of
  another company and anonymous visitors see **zero** victim rows in every table/view with `company_id` (66 relations, 55 with
  seeded data), only `company-assets` is a public bucket, no private object readable cross-company, Realtime publication holds
  exactly the 4 tables that never broadcast cross-tenant DELETE events (migration 1200).
- `roles_matrix.test.ts` — locks the 7 built-in roles to the documented permission matrix (32 keys).

## Unit (`tests/unit`)
- `pdf.test.ts` — offer-template placeholder rendering, template vs standard offer letter, paginated report PDF.

## Demo E2E additions
- `e2e/gaps.spec.ts` — employee correction request → manager approval, team calendar, dark-mode toggle/persistence,
  bulk tag + bulk stage move, offer template create + preview, attendance report PDF download, careers education fields +
  reference number, dark-mode rendering of main pages (shares one booted demo database across its tests).

## Test data & safety
- Tests use isolated databases (PGlite) or pre-confirmed admin-created users with random suffixes on the dedicated
  `talentflow-hrms` project, and delete everything they create. No production data is touched.
- No real emails are sent by tests: the live test that invokes the email worker runs only with `LIVE_EMAIL_MODE=mock`
  (the project now uses a real provider), and test users are created without confirmation mail.

## Results
See UAT_REPORT.md for the latest run.
