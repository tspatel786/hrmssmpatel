# Environment setup

Requirements: Node 20+, npm 10+. Optional: Supabase CLI (`npx supabase`), Playwright browsers (`npx playwright install chromium`).

```bash
npm install
cp .env.example .env.local   # fill in to use Supabase; leave empty for demo mode
npm run dev
```

## Frontend variables (`.env.local`, safe for the browser)

| Variable | Required | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | for Supabase mode | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | for Supabase mode | Project anon (publishable) key |
| `VITE_BACKEND_MODE` | no | `supabase` or `demo` (default: supabase when URL+key exist) |
| `VITE_PUBLIC_APP_URL` | no | Base URL used in emailed links (defaults to `window.location.origin`) |

`.env.demo` forces demo mode for `npm run build:demo` / E2E regardless of `.env.local`.

## Edge Function secrets (`supabase secrets set …`) — never in `VITE_*`

| Secret | Description |
|---|---|
| `EMAIL_MODE` | `mock` (default — logs as sent without delivering) or `resend` |
| `RESEND_API_KEY` | Required for `resend` mode |
| `EMAIL_FROM` | Verified sender, e.g. `HRMS <no-reply@yourdomain.com>` |
| `EMAIL_TEST_RECIPIENT` | Optional: redirect every email to this inbox (UAT) |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into Edge Functions.

## Local test credentials

- `supabase/.temp/service-role-key` (gitignored) — used only by `npm run test:live` and the Supabase E2E project.
- Migration tooling reads `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` from the environment (never from files).

## Current project

Supabase project `talentflow-hrms` (ref `ivtkeglfocvoyhcrpmfl`, region ap-south-1, Free plan). Migrations 0100–1100
applied; Edge Function `process-emails` deployed with `EMAIL_MODE=mock`. Auth site URL: `http://localhost:5173`.
