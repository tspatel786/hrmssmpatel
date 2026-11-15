# HRMS completion audit

Status legend: **COMPLETED** · **PARTIAL** (works, specific sub-features missing) · **NOT STARTED**.
Every COMPLETED item has a UI, real database integration and automated test coverage (see TESTING.md).

| # | Module | Status | Notes / exact gaps |
|---|---|---|---|
| 1 | SaaS super admin | COMPLETED | Platform stats, company list, create company + invite admin, plan/limit/status (suspend) |
| 2 | Multi-company | COMPLETED | Company switcher, per-company roles, RLS isolation (tested live) |
| 3 | Authentication | COMPLETED | Signup, login, logout, forgot/reset password (Supabase), invitations auto-accepted on sign-in |
| 4 | Roles & permissions | COMPLETED | 32 permissions, 7 default + custom roles, permission matrix UI, guard rules |
| 5 | Public careers site | PARTIAL | Listing, search, filters, detail, apply with resume, rate limiting, duplicate prevention, confirmation email. Gaps: per-company URL instead of global `/careers`, no education fields, no reference number shown |
| 6 | Job requisitions | COMPLETED | Draft → submit → approve/reject (no self-approval) → create job |
| 7 | Job openings | COMPLETED | CRUD, publish/hold/close, careers link, auto-close when filled |
| 8 | Applications | COMPLETED | Public + manual, resume required, stage history |
| 9 | Candidate management | PARTIAL | Profile, notes, ratings, timeline, search, documents. Gap: bulk actions |
| 10 | Recruitment pipeline | COMPLETED | Drag-and-drop Kanban (+ mobile move menu), guarded transitions |
| 11 | Resume management | COMPLETED | Private storage, signed-URL preview/download, extra documents |
| 12 | Interview scheduling | PARTIAL | Rounds, types, panel, conflict detection, reschedule, cancel, no-show. Gap: reminder emails |
| 13 | Interview calendar | COMPLETED | Month / week / list views, "my interviews" filter |
| 14 | Interview feedback | COMPLETED | Overall/technical/communication/culture ratings, recommendation, strengths/concerns |
| 15 | Email automation | COMPLETED | 16 events, outbox in same transaction, dedupe, retry, server-side delivery (mock until provider configured) |
| 16 | Email templates | COMPLETED | Editable subject/body, variables, live preview, enable/disable, test send |
| 17 | Email logs | COMPLETED | Status, attempts, errors, rendered preview, attachments, retry |
| 18 | Offer management | PARTIAL | CRUD, CTC breakup, history. Gap: multiple offer templates (single branded layout) |
| 19 | Offer PDF | COMPLETED | Branded PDF, uploaded and attached to the offer email |
| 20 | Offer approval | COMPLETED | Configurable approval, no self-approval, comments |
| 21 | Secure offer acceptance | COMPLETED | Hashed 256-bit token, expiry, e-signature, accept/decline, rate limit |
| 22 | Onboarding | COMPLETED | Auto-created on acceptance, checklist template, joining confirmation, employee creation, duplicate prevention |
| 23 | Employee management | COMPLETED | Directory, profile, compensation, bank, documents, reporting lines, login invitation |
| 24 | Departments | COMPLETED | CRUD, hierarchy, heads, org chart |
| 25 | Designations | COMPLETED | CRUD with levels |
| 26 | Attendance | PARTIAL | Clock in/out, half day, absent, leave, holidays, daily register, HR corrections, reports. Gaps: late/early flags, employee correction-request workflow |
| 27 | Leave management | PARTIAL | Types, balances (carry-forward), apply, approve (HR or manager), cancel, notifications. Gap: team calendar view |
| 28 | Payroll | COMPLETED | Salary structure, LOP from unpaid leave/absence, PF/PT/TDS (configurable), draft → processed → paid |
| 29 | Payslips | COMPLETED | PDF payslips, employee self-service, email notification |
| 30 | Dashboard & analytics | COMPLETED | Live KPIs and charts from real data, self-service dashboard |
| 31 | Reports & export | PARTIAL | 7 reports, CSV export, print. Gap: server-generated PDF reports |
| 32 | Notifications | COMPLETED | In-app bell, page, triggers for workflow events and announcements |
| 33 | Audit logs | COMPLETED | 25 tables, diffs, filters, export |
| 34 | Company settings | COMPLETED | Profile, branding/logo, careers, HR & payroll policies, users, roles, onboarding template |
| 35 | **Communication — DMs** | COMPLETED | Search people (name/ID/department), realtime, timestamps, sent/delivered/read, unread counts, reply, edit, delete, reactions, copy, pin, search |
| 36 | **Communication — groups** | PARTIAL | Create, describe, add/remove, admins, leave, member list, notifications. Gap: group image upload UI |
| 37 | **Realtime & notifications** | COMPLETED | Supabase Realtime (RLS), idempotent sends, optimistic UI, reconnect resync, pagination, Web Audio chime, browser notifications, mute, cross-tab dedupe |
| 38 | **Attachments** | COMPLETED | Images (preview), PDF/Office/CSV/ZIP, 25 MB limit, private bucket, participant-only access |
| 39 | **Announcements** | COMPLETED | Company/department targeting, pin, attachments, acknowledgement tracking, notifications |
| — | Dark mode | NOT STARTED | Light theme only |

## Notes on stack choices
shadcn/ui and FullCalendar were not used: the project already had a consistent Tailwind component library and a custom
calendar, and replacing them would have rewritten working UI without functional gain (the instruction was to preserve
working functionality).
