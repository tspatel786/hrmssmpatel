# HRMS completion audit

Status legend: **COMPLETED** · **PARTIAL** (works, specific sub-features missing) · **NOT STARTED** · **NEEDS BUG FIXING** · **NEEDS TESTING**.

_Last audit: 2026-11-15 (Communication UAT — see COMMUNICATION_MODULE_UAT_REPORT.md)._
Every COMPLETED item has a UI, real database integration and automated test coverage (see TESTING.md).

| # | Module | Status | Notes / exact gaps |
|---|---|---|---|
| 1 | SaaS super admin | COMPLETED | Platform stats, company list, create company + invite admin, plan/limit/status (suspend) |
| 2 | Multi-company | COMPLETED | Company switcher, per-company roles, RLS isolation (tested live) |
| 3 | Authentication | COMPLETED | Signup, login, logout, forgot/reset password (Supabase), invitations auto-accepted on sign-in |
| 4 | Roles & permissions | COMPLETED | 32 permissions, 7 default + custom roles, permission matrix UI, guard rules |
| 5 | Public careers site | COMPLETED | Listing, search, filters, detail, apply with resume, education (qualification/institution/year), reference number on success, rate limiting, duplicate prevention, confirmation email. Per-company URLs by design |
| 6 | Job requisitions | COMPLETED | Draft → submit → approve/reject (no self-approval) → create job |
| 7 | Job openings | COMPLETED | CRUD, publish/hold/close, careers link, auto-close when filled |
| 8 | Applications | COMPLETED | Public + manual, resume required, stage history |
| 9 | Candidate management | COMPLETED | Profile, notes, ratings, timeline, search, documents, education, tags; bulk tag/untag + export of selected (added 2026-11-15) |
| 10 | Recruitment pipeline | COMPLETED | Drag-and-drop Kanban (+ mobile move menu), guarded transitions, bulk stage move / bulk reject with per-item results (added 2026-11-15) |
| 11 | Resume management | COMPLETED | Private storage, signed-URL preview/download, extra documents |
| 12 | Interview scheduling | COMPLETED | Rounds, types, panel, conflict detection, reschedule, cancel, no-show, 24 h reminder emails to candidate + panel and in-app panel notification (added 2026-11-15; Supabase needs migration 1400 + function redeploy/pg_cron) |
| 13 | Interview calendar | COMPLETED | Month / week / list views, "my interviews" filter |
| 14 | Interview feedback | COMPLETED | Overall/technical/communication/culture ratings, recommendation, strengths/concerns |
| 15 | Email automation | COMPLETED | 16 events, outbox in same transaction, dedupe, retry, server-side delivery (mock until provider configured) |
| 16 | Email templates | COMPLETED | Editable subject/body, variables, live preview, enable/disable, test send |
| 17 | Email logs | COMPLETED | Status, attempts, errors, rendered preview, attachments, retry |
| 18 | Offer management | COMPLETED | CRUD, CTC breakup, history, multiple letter templates with placeholders, default template, PDF preview (added 2026-11-15) |
| 19 | Offer PDF | COMPLETED | Branded PDF, uploaded and attached to the offer email |
| 20 | Offer approval | COMPLETED | Configurable approval, no self-approval, comments |
| 21 | Secure offer acceptance | COMPLETED | Hashed 256-bit token, expiry, e-signature, accept/decline, rate limit |
| 22 | Onboarding | COMPLETED | Auto-created on acceptance, checklist template, joining confirmation, employee creation, duplicate prevention |
| 23 | Employee management | COMPLETED | Directory, profile, compensation, bank, documents, reporting lines, login invitation |
| 24 | Departments | COMPLETED | CRUD, hierarchy, heads, org chart |
| 25 | Designations | COMPLETED | CRUD with levels |
| 26 | Attendance | COMPLETED | Clock in/out, half day, absent, leave, holidays, daily register, HR corrections, late-arrival/early-departure flags with configurable grace, employee correction requests approved by manager/HR (no self-approval), reports with late/early counts (added 2026-11-15) |
| 27 | Leave management | COMPLETED | Types, balances (carry-forward), apply, approve (HR or manager), cancel, notifications, team leave calendar with privacy-scoped visibility (added 2026-11-15) |
| 28 | Payroll | COMPLETED | Salary structure, LOP from unpaid leave/absence, PF/PT/TDS (configurable), draft → processed → paid |
| 29 | Payslips | COMPLETED | PDF payslips, employee self-service, email notification |
| 30 | Dashboard & analytics | COMPLETED | Live KPIs and charts from real data, self-service dashboard |
| 31 | Reports & export | COMPLETED | 7 reports, CSV export, print, branded PDF export (browser-generated, paginated, totals) (added 2026-11-15) |
| 32 | Notifications | COMPLETED | In-app bell, page, triggers for workflow events and announcements |
| 33 | Audit logs | COMPLETED | 25 tables, diffs, filters, export |
| 34 | Company settings | COMPLETED | Profile, branding/logo, careers, HR & payroll policies, users, roles, onboarding template |
| 35 | **Communication — DMs** | COMPLETED | Search people (name/ID/department), realtime, typing (expiry fixed), presence status, timestamps, sent/delivered/read, unread counts, reply, edit, delete, reactions, copy, pin, search |
| 36 | **Communication — groups** | COMPLETED | Create, describe, add/remove, admins, leave, member list, notifications, group photo upload (added in UAT) |
| 37 | **Realtime & notifications** | NEEDS BUG FIXING (deploy) | Fix written & DB-tested (migration 1200: Realtime DELETE events leaked chat UUIDs across companies, verified live); must be applied to Supabase. Otherwise: Supabase Realtime (RLS), idempotent sends, optimistic UI, reconnect resync, pagination, Web Audio chime, browser notifications, mute, cross-tab dedupe |
| 38 | **Attachments** | COMPLETED | Images (preview), PDF/Office/CSV/ZIP, 25 MB limit, private bucket, participant-only access |
| 39 | **Announcements** | COMPLETED | Company/department targeting, pin, attachments, acknowledgement tracking, notifications |
| — | Dark mode | COMPLETED | Light / dark / system toggle in the header, persisted per browser; light remains the default (added 2026-11-15) |

## Notes on stack choices
shadcn/ui and FullCalendar were not used: the project already had a consistent Tailwind component library and a custom
calendar, and replacing them would have rewritten working UI without functional gain (the instruction was to preserve
working functionality).
