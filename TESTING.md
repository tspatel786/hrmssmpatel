# Testing

## Layers

| Layer | Command | What it covers |
|---|---|---|
| Static | `npm run typecheck`, `npm run lint` | TypeScript strict mode, ESLint (react-hooks, no unused) — zero warnings policy |
| Unit | `npx vitest run tests/unit` | Open-redirect guard, CSV formula-injection escaping, amount-in-words |
| Database (PGlite) | `npx vitest run tests/db` | The **real migrations** in Postgres 18 WASM through the same adapter the app uses, with RLS enforced per call |
| Live Supabase | `npm run test:live` | Real Auth + PostgREST + Storage RLS + deployed Edge Function on the configured project (opt-in, self-cleaning) |
| E2E (demo) | `npm run test:e2e` | Playwright against the demo build: full hiring lifecycle through the UI, roles, navigation, mobile layout |
| E2E (Supabase) | `SUPABASE_LIVE=1 npx playwright test --project=supabase` | Two browser contexts, real Realtime: DMs, groups, sound, receipts, files, search, mute, multi-tab dedupe, isolation |

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

## Test data & safety
- Tests use isolated databases (PGlite) or pre-confirmed admin-created users with random suffixes on the dedicated
  `talentflow-hrms` project, and delete everything they create. No production data is touched.
- No real emails are sent: the Edge Function runs in `mock` mode and test users are created without confirmation mail.

## Results
See UAT_REPORT.md for the latest run.
