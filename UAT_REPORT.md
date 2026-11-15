# UAT Report

## Latest run — 2026-11-15 (branch `feature/comm-security-and-hr-gaps`, after the Communication security review)

The production Supabase project still runs schema 0100–1100. **Migration 1200 is not applied**, so the production
Realtime security issue is **NOT resolved** (see the Live Realtime row and `MIGRATION_1200_RUNBOOK.md`).

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS (0 errors) |
| Lint (zero warnings) | `npm run lint` | PASS |
| Unit + DB (PGlite, real migrations 0100–1400, RLS per call) | `npx vitest run tests/unit tests/db` | **126 / 126 PASS** |
| Production build | `npm run build` | PASS (built in 26.6 s) |
| Live Supabase integration | `npm run test:live` → `live.test.ts` | **8 / 8 PASS** (lifecycle, tenant isolation, storage, offer token, edge function) |
| Live Realtime (current schema, without 1200) | `npm run test:live` → `realtime.test.ts` | **3 / 4** — delivery PASS (≈ 0.6 s); typing/receipts/reactions propagate PASS; **direct cross-company access PASS** (12 tables/views, 10 write RPCs, storage list/download/sign/upload); **DELETE-event isolation FAIL** (expected until 1200: leaked PKs from `chat_typing_status`, `chat_reactions`, `chat_participants`, `announcements`) |
| Live Communication E2E (current schema, new per-table Realtime client) | `SUPABASE_LIVE=1 npx playwright test --project=supabase` | **3 / 3 PASS** |
| Demo E2E (desktop + mobile, in-browser Postgres) | `npx playwright test` | **NOT CONCLUSIVE** — see below |

### Demo E2E — environment-blocked, not a code regression
- Full run: 1 passed (gaps: correction request → manager approval, team calendar, dark-mode toggle), 6 failed — **every
  failure is the demo boot (`bootDemo`, "Starting the demo workspace" > 120 s)**, none is an assertion in the app.
- Original specs only (lifecycle, roles ×3, mobile): 5 / 5 failed at the same boot step.
- **Control:** the same specs on the pre-branch commit `cbf2caa` (separate worktree) also failed 2 / 2 at the same boot step.
- The complete demo boot path (migrations 0100–1400 + seed + email/reminder worker) completes in **16 s in Node** under the
  same load, and the seed test passes; the browser boot measured 47–53 s when the machine was less busy.
- The machine was heavily loaded during these runs (other projects' dev servers, two HRMS dev servers, desktop Chrome).
- Earlier the same day, before this branch's changes, the 5 original demo specs passed 5 / 5.
- **Action before merge:** re-run `npx playwright test` on an idle machine or CI. Not claimed as passing.

### Security conclusion
- Company A ↔ B isolation for reads, writes (DMs, groups, membership, reactions, pins, edits, deletes), attachments and
  storage: **verified live — PASS**.
- Realtime metadata leak through DELETE events: **verified live — still OPEN in production.** Fix = migration 1200
  (written, DB-tested, not applied). Resolved only when `realtime.test.ts` passes **4 / 4** after applying it.

Module-level Communication results: **COMMUNICATION_MODULE_UAT_REPORT.md**. Deployment steps: **MIGRATION_1200_RUNBOOK.md**.

### Not executed
- Applying migrations 1200–1400 to Supabase (not authorized; no management token).
- Real email delivery (provider in mock mode).
