# TalentFlow HRMS

Multi-tenant SaaS HRMS: **recruitment → interviews → offers → onboarding → employees → attendance → leave → payroll**, plus
**Slack-style internal communication**, email automation, analytics, audit logs and a SaaS super-admin console.

Built with React 18 + TypeScript + Vite + Tailwind, TanStack Query, React Hook Form + Zod, Recharts, jsPDF,
and **Supabase** (Postgres + RLS, Auth, Storage, Realtime, Edge Functions).

## Two run modes

| Mode | When | Backend |
|---|---|---|
| **Supabase** | `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` set | Real Supabase project (Auth, Postgres/RLS, Storage, Realtime, Edge Functions) |
| **Demo** | no credentials (or `--mode demo`) | The **same SQL migrations** run in-browser on PGlite (Postgres 18 WASM), persisted to IndexedDB, with seeded sample data and mock email delivery |

Demo mode is not a mock UI: every query goes through the same RLS policies and RPC business logic as production.

## Quick start

```bash
npm install
npm run dev            # uses .env.local if present (Supabase), otherwise demo mode
npm run build:demo && npm run preview:demo   # force demo mode at http://localhost:4173
```

Demo accounts (password `Demo@12345`): `hr@nimbus.test` (Company Admin), `recruiter@nimbus.test`, `manager@nimbus.test`,
`payroll@nimbus.test`, `employee@nimbus.test`, `admin@platform.test` (SaaS super admin).

Public pages: `/careers/nimbus` (careers site), `/offer/<token>` (secure offer acceptance).

## Modules

SaaS super admin · multi-company · auth (signup, login, reset) · roles & permissions · public careers site · requisitions ·
job openings · applications · candidates & resumes · Kanban pipeline · interview scheduling & calendar · feedback ·
email automation, templates & logs · offers (approval, PDF, secure e-acceptance) · onboarding · employees · departments &
designations · attendance · leave · payroll & payslip PDFs · dashboards · reports & CSV export · notifications · audit logs ·
company settings · **communication** (DMs, groups, realtime, sound + browser notifications, attachments, reactions,
pins, read receipts, announcements).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` / `build:demo` | Production build (Supabase / demo) |
| `npm run typecheck`, `npm run lint` | Static checks |
| `npm test` | Vitest: DB suites on real migrations (PGlite) |
| `npm run test:live` | Live integration tests against the configured Supabase project |
| `npm run test:e2e` | Playwright E2E (demo build); `SUPABASE_LIVE=1 npx playwright test --project=supabase` for realtime chat E2E |
| `npm run db:apply` | Apply pending migrations via Supabase Management API (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`) |

See [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md), [DEPLOYMENT.md](DEPLOYMENT.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md), [SECURITY.md](SECURITY.md), [TESTING.md](TESTING.md), [UAT_REPORT.md](UAT_REPORT.md),
[KNOWN_ISSUES.md](KNOWN_ISSUES.md), [HRMS_COMPLETION_AUDIT.md](HRMS_COMPLETION_AUDIT.md).
