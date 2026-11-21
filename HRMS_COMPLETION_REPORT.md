# S.M. PATEL HRMS – Completion Report

Date: 22 November 2026 · Live: https://connect.smpatelithub.in · Repository: github.com/tspatel786/hrmssmpatel (`main` = live internal HRMS, `product` = SaaS version, same code)

## 1. Existing modules inspected

Before building anything, the existing application was inspected end to end: React/Vite frontend, Supabase Postgres schema and
all 20 migrations, Row Level Security policies, storage buckets and policies, Edge Functions (`process-emails`, `employee-auth`),
authentication (email/password, Employee ID sign-in, one-time activation links), roles and permissions, and the test suites.

| Module | State found | Action |
|---|---|---|
| Recruitment, hire-to-login, onboarding, joining documents | Complete (migration 1900) | Unchanged |
| Branding, login, role dashboards | Complete (1500–1700) | Unchanged; dashboards extended with new cards only |
| Attendance: clock in/out, late/early flags, hours, regularization with manager/HR approval, register, calendar, report | Complete (0700, 1300) | Added automatic absences; added acceptance tests |
| Leave: types, balances, full/half day, overlap & balance checks, manager approval, calendar, history, report | Complete (0700, 1300) | Rejection now requires a reason (server rule); acceptance tests |
| Resignation & exit | Missing | **Built** |
| Document management | Employee documents uploaded by HR only | **Extended** (self-upload, verification, expiry, history, company documents) |
| Notifications | In-app + email for every notification (1900) | Fixed dedupe so several reminders in one run are all emailed; new events added |
| Backups | None configured on the Supabase plan | Backup script + procedure |

## 2. Completed work

- Attendance and Leave verified end to end against the acceptance list; two gaps closed (absences, rejection reason).
- Resignation & Exit implemented completely (section 3).
- Document Management implemented on top of the existing employee documents (no duplication of joining-document verification).
- Notifications completed for all requested events; daily reminders run automatically.
- HR, manager and employee dashboards extended; two new reports.
- Security re-verified on the live database; backup procedure created and a first backup taken.

## 3. New functionality

### Attendance
- **Automatic absences:** every past working day (weekends and holidays excluded) without an attendance record becomes
  `absent` (source `system`) for employees employed that day. Today is never auto-marked. An approved regularization replaces it.
- Everything else already existed and is now covered by acceptance tests (see section 6).

### Leave
- Rejecting a leave request requires a reason (the UI already asked; the server now enforces it).

### Resignation & Exit (`/app/exits`)
1. Employee submits resignation with reason and proposed last working day (company notice period suggested; set in Settings → Policies).
2. Reporting manager is notified and approves or rejects (rejection needs a reason). If there is no manager it goes straight to HR.
3. HR approves (sets the final last working day) or rejects. On approval the employee moves to **notice**, the exit date is set and a
   6-item exit checklist is created (handover, assets, documents, access, dues, exit interview); HR can add/remove items.
4. Notice period tracked (days left shown); reminders 7 days and 1 day before the last day to HR and the employee.
5. Final settlement recorded (pending / processing / paid / not applicable, amount, note).
6. **Relieving letter** and **experience letter** generated on the company letterhead, saved to the employee's documents and emailed.
7. **Complete exit** requires the checklist done and the settlement paid/not applicable.
8. Access is closed **the day after the last working day** (employee → inactive, login membership → inactive) — never at submission.
9. Withdrawal: instant while pending; after approval it becomes a cancellation request that HR approves (employee back to active) or rejects.
10. Tabs: My resignation, My team, Pending, On notice, History. Every step notifies the right people in-app and by email.

### Document Management (`/app/documents`)
- **My documents:** employees upload Aadhaar, PAN, ID/address proof, education, experience, tax and other documents (PDF, JPG, PNG, Word;
  max 10 MB) with an optional expiry date. Uploads are *Awaiting verification*; HR letters (offer, appointment, relieving, experience) appear here too.
  Link to salary slips.
- **To verify (HR):** verify or reject with a reason; the employee is notified.
- **Expiring (HR):** documents expired or expiring within 30 days. Reminders at 30 days, 7 days and on the day.
- **Employee documents (HR):** all documents, filter by type, link to the employee.
- **Company documents:** policies, handbook, forms, agreements; visible to all employees or HR only; managed by the company admin; expiry reminders.
- **History** of each document (uploaded, rejected, verified, deleted) from the audit trail.
- Files stay in the private `documents` bucket and open through short-lived signed URLs.

### Dashboards
- **HR:** total employees, present today, absent/not in, on leave, pending leave, pending resignations, documents to verify,
  employees on notice, birthdays in the next 30 days, documents expiring in 30 days.
- **Manager:** existing team card (team attendance, leave and correction approvals) plus resignations waiting for them.
- **Employee:** existing attendance and leave balance plus my documents, my pending leave and my resignation status.

### Reports
- **Employee exits** (date range): last working day, approvals, settlement, tenure.
- **Employee documents:** status, rejection reason and expiry for every document.

### Daily jobs
`run_daily_jobs()` runs once per company per day (guarded by `daily_job_runs`), triggered by the email worker which the app calls
after actions: absences, notice reminders, document expiry reminders, post-exit deactivation.

## 4. Database migrations

| Migration | Content | Live |
|---|---|---|
| 1500 role dashboards | Team view, role-filtered dashboards, HM approvals, HR employee access | Applied 21 Nov |
| 1600 product name | Invitation email product name | Applied 21 Nov |
| 1700 sign-up switch | Internal (invitation only) vs SaaS mode — live set to internal | Applied 21 Nov |
| 1800 company delete fix | Companies with announcements can be deleted | Applied 21 Nov |
| 1900 hire-to-login | Internal openings, joining documents, Employee ID login, appointment letter, letterhead | Applied 22 Nov |
| **2000 exit, documents, daily jobs** | Resignations, exit tasks, company documents, document verification/expiry, daily jobs, overviews, reports, leave rejection reason, notification dedupe fix | **Applied 22 Nov** |

Every migration was dry-run first, applied alone, and preceded by a rollback snapshot of the functions it replaces
(`supabase/.temp/backup-before-*.sql`). No table was dropped and no data deleted. Edge Function `process-emails` redeployed with the daily jobs.

## 5. Security and permission checks

- **Multi-tenant isolation:** the catalog-wide test checks every table with `company_id` (including the new ones) — another company sees zero rows.
- **Live audit (22 Nov):** every public table has RLS enabled; the only company table without a foreign key to `companies` is `audit_logs`
  (intentional: history survives deletion); the only public bucket is `company-assets` (logos/letterhead, intentional).
- **Resignations:** visible to the employee, their reporting manager and HR only; all state changes go through server functions;
  only the reporting manager decides step 1; HR cannot approve their own resignation; employees cannot edit checklists or status.
- **Documents:** employees upload only into their own folder and only as *pending*; cannot verify, cannot delete verified documents;
  managers do not see team members' personal documents; HR cannot verify their own; company "HR only" documents hidden from employees;
  storage paths validated in policies; signed URLs for viewing.
- **Daily jobs and token functions** are executable only by the service role.
- **Dates** use the company time zone (Asia/Kolkata) everywhere — a UTC/IST off-by-one bug was found and fixed by the tests.
- **Secrets:** no secret in frontend code; service key only in Edge Functions and the gitignored `supabase/.temp`; backups gitignored.

## 6. Test cases executed

| Suite | Scope |
|---|---|
| Typecheck + lint (`--max-warnings=0`) | Whole codebase |
| Unit + database tests (PGlite, real migrations and RLS) | 19 files incl. new `exit_documents` (7) and `attendance_leave_acceptance` (4) |
| Live database tests (`SUPABASE_LIVE=1`) | Lifecycle, isolation, storage, realtime chat, migration 1500, hire-to-login via deployed functions |
| Browser E2E (Playwright, demo build) | Desktop, mobile (Pixel 7), tablet (768 px); new `exits_documents` spec |

New acceptance cases include: check-in/out once per day, invalid times rejected, worked minutes (09:00–18:30 = 570), report hours,
automatic absence and its regularization, half-day leave = 0.5 day, invalid ranges, duplicates, balance consumed only on approval,
manager-only decisions, team-only visibility, resignation full path, withdrawal paths, completion gates, deactivation after the last day,
exit letters emailed, document self-upload/verify/reject/history, company document visibility, daily job idempotency, overview numbers, report permissions.

## 7. Test results

| Check | Result |
|---|---|
| Typecheck | **Pass** |
| Lint (`--max-warnings=0`) | **Pass** |
| Unit + database tests | **178 passed**, 0 failed (19 live-only tests skipped locally) — incl. new `exit_documents` 7/7 and `attendance_leave_acceptance` 4/4 |
| Live database tests (before migration 2000) | **18/18 passed** (hire-to-login via deployed functions, isolation, storage, realtime chat, roles) |
| Live database audit after migration 2000 | **Pass** (RLS on every table, FKs, buckets — section 5) |
| Browser E2E for the new screens (`exits_documents`, responsive incl. Documents/Exits/Openings, daily) | **9 passed, 3 failed, then the run was stopped for low memory.** Passed: employee resigns + uploads a document, manager approves, all daily-use checks. Failed: (1) HR exit checklist tick did not show until the server answered — **fixed** (optimistic update, as on the onboarding checklist), not yet re-run; (2–3) mobile/tablet runs: test worker crashed from low memory, not an app error. Re-run with other apps closed: `npx playwright test e2e/exits_documents.spec.ts e2e/responsive.spec.ts`. |
| Earlier full browser E2E (before 1900/2000) | 20/20 passed on desktop, mobile and tablet |

## 8. Bugs found and fixed

1. **Time zone off-by-one** in notice days / document expiry (server UTC date used instead of company date) — fixed before release.
2. **Notification dedupe too broad:** several generic notifications to one person in a single transaction (e.g. daily reminders) were
   reduced to one email — now only a dedicated email from the same operation suppresses the generic copy.
3. **Leave rejection without a reason** was accepted by the server — now refused.
4. **Exit checklist tick lag** (found by the browser test): the checkbox changed only after the server reply — now updates instantly and reverts on failure.
5. Earlier in the project (already deployed): joining-document upload refused on Supabase (upsert), company deletion blocked by the
   announcement trigger, live-test user collision, demo boot timeouts in long E2E runs.

## 9. Remaining issues

- Daily jobs run when the app is used (the worker is called after actions). For guaranteed daily timing, add a Supabase cron schedule
  (Dashboard → Integrations → Cron: call `process-emails` once an hour). Optional for a small team.
- Storage files are not included in the JSON backup (only their list); download them from the Supabase dashboard for a full offline copy.
- 3 leftover automated-test companies ("Chat E2E Co") remain in the live database pending the owner's decision.

## 10. Deployment status

- Code: `main` and `product` pushed (Render redeploys `main` to connect.smpatelithub.in automatically).
- Database: migrations up to 2000 applied and verified on the live project.
- Edge Functions: `employee-auth` and `process-emails` deployed.
- Live data backup taken before migration 2000 (`backups/`, gitignored).

## 11. Manual actions required from the owner

1. **Revoke the Supabase access token** that was shared in chat (Dashboard → Account → Access tokens).
2. **Backups:** run `node scripts/backup-export.mjs` regularly (e.g. weekly) and keep copies offline, or upgrade to a Supabase plan with daily backups.
3. Optional: add the hourly cron for `process-emails` (see section 9).
4. Decide on the leftover test companies ("Chat E2E Co" ×3) and the "Hrms" company.
5. Set the notice period in Settings → Policies (default 30 days) and upload company policies under Documents → Company documents.

### Backup procedure
1. `node scripts/backup-export.mjs` — exports every table to `backups/<project>/<timestamp>/` with a `manifest.json` (row counts).
2. Copy the folder to offline storage (encrypted drive). It contains personal data: never commit or share it.
3. Before any schema change, also save the affected function definitions (done automatically in `supabase/.temp/backup-before-*.sql` during this project).
4. Restore: re-create the schema with `node scripts/supabase-apply.mjs` on a fresh project, then import the JSON files table by table in
   dependency order (companies → roles → employees → …) with the service role.
