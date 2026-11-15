# UAT Report

## Latest run — 2026-11-15 (Communication UAT + full regression)

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS |
| Lint (zero warnings) | `npm run lint` | PASS |
| Unit + DB (PGlite, real migrations, RLS) | `npx vitest run tests/unit tests/db` | **103 / 103 PASS** (incl. 5 new Communication regression tests) |
| Production build | `npm run build` | PASS |
| Demo E2E (desktop + mobile) | `npx playwright test` | **5 / 5 PASS** — hiring lifecycle, roles ×3, mobile shell |
| Live Supabase integration | `npm run test:live` → `live.test.ts` | **8 / 8 PASS** — lifecycle, tenant isolation, storage, offer token, edge function |
| Live Realtime | `npm run test:live` → `realtime.test.ts` | **2 / 3** — delivery & propagation PASS; cross-company isolation **FAIL until migration 1200 is applied** (verified leak, fix written) |
| Live Communication E2E | `SUPABASE_LIVE=1 npx playwright test --project=supabase` | **3 / 3 PASS** |

Module-level Communication results (14 features, PASS/FAIL/NOT IMPLEMENTED with evidence): **COMMUNICATION_MODULE_UAT_REPORT.md**.

### Not executed in this run
- Real email delivery (provider not configured — mock mode, see KNOWN_ISSUES).
- Applying migration 1200 to the Supabase project (needs a management token and your authorization).
