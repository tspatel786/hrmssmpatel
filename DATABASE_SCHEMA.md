# Database schema

PostgreSQL (Supabase, tested on Postgres 17 and PGlite/Postgres 18). 49 tables, 25 views, ~130 functions, 104 RLS policies.
All tenant tables carry `company_id`, UUID primary keys and RLS.

## Migrations (`supabase/migrations`, applied in order)

| File | Contents |
|---|---|
| `0100_core_tenancy` | companies, profiles (auto-created from `auth.users`), platform_admins, permissions catalog, roles, role_permissions, company_members, company_invitations, `is_member` / `has_permission` / `my_permissions` helpers |
| `0200_people` | departments, designations, employees (auto employee codes, plan limit), holidays, attendance_records, leave_types, leave_balances, leave_requests, payroll_runs, payslips |
| `0300_recruitment` | job_requisitions, jobs, candidates, applications, application_stage_history, candidate_notes, candidate_documents, interviews, interview_panelists, interview_feedback, offers, offer_approvals, onboarding_task_templates, onboardings, onboarding_tasks, public_submission_log |
| `0400_comms_audit` | email_templates, email_logs (outbox, dedupe), notifications, audit_logs + generic audit trigger |
| `0500_provisioning` | template rendering & email layout, company default seeding (roles, departments, leave types, checklist, 16 email templates), create_company, invitations, super-admin RPCs |
| `0600_recruitment_logic` | public careers RPCs, rate limiting, pipeline automation & emails, interview scheduling with conflict detection, feedback, offer approval/sending/secure acceptance, onboarding → employee |
| `0700_hr_logic` | attendance (clock in/out, manual), leave (working-day calc, balances, approvals), payroll generation (LOP), dashboards, reports, email worker API |
| `0800_rls` | integrity guards + all RLS policies |
| `0900_views_storage` | read views (`security_invoker`), storage buckets & policies |
| `1000_employee_documents` | employee document metadata |
| `1100_communication` | chat_conversations, chat_participants, chat_messages, chat_attachments, chat_reactions, chat_typing_status, chat_user_presence, chat_notification_preferences, announcements, announcement_reads; chat RPCs, views (`v_chat_messages`, `v_chat_directory`, `chat_message_reads`…), chat-attachments bucket, realtime publication |

`supabase/local/shim.sql` provides the Supabase `auth`/`storage` schemas and roles for PGlite only — never applied to Supabase.

## Naming vs. specification

The specification's table names map to existing tables as follows (no duplicate schemas were created):
`job_openings`→`jobs`, `job_applications`→`applications`, `application_status_history`→`application_stage_history`,
`interviewers`→`interview_panelists`, `job_offers`→`offers`, `offer_actions`→`offer_approvals`, `attendance`→`attendance_records`,
`salary_structures`→salary columns on `employees`, `payroll`→`payroll_runs`, `company_settings`→columns on `companies`,
`user_roles`/`company_memberships`→`roles` + `company_members`, `email_events`→`email_logs` (event key + dedupe key),
`chat_message_reads`→view derived from participant read cursors.

## Stages

Application stages: applied, screening (Under Review), shortlisted, interview, selected, offered (Offer Sent), hired (Joined),
on_hold, rejected, withdrawn. Offer statuses: draft, pending_approval, approved, rejected, sent, accepted, declined, expired, withdrawn.

## Indexes

Every foreign-key lookup used by RLS or list pages is indexed (e.g. `company_members(user_id, company_id)`,
`applications(company_id, stage)`, `interviews(company_id, scheduled_at)`, `chat_messages(conversation_id, created_at desc)`,
`email_logs(status, created_at) where status in ('queued','failed')`). Unique constraints enforce one live offer per
application, one DM per user pair, idempotent chat sends, unique employee codes/emails per company.
