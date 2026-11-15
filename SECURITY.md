# Security

## Tenant isolation
- Every tenant table has RLS enabled (verified: 0 public tables without RLS on the live project).
- Policies call `is_member(company_id)` / `has_permission(company_id, perm)` (SECURITY DEFINER, `search_path` pinned);
  suspended companies lose access automatically.
- Cross-tenant references are rejected by `guard_same_company` triggers (e.g. an employee cannot point at another
  company's department).
- Read views are `security_invoker` so they inherit RLS.
- Verified by automated tests (PGlite + live Supabase): a user of company B sees zero rows of company A in 14+ tables,
  cannot update/delete/insert into A, cannot call A's RPCs, and cannot read A's storage objects.

## Roles & permissions
31 permission keys (+ `announcements.manage`), 7 default roles (Company Admin, HR Manager, Recruiter, Hiring Manager,
Payroll Manager, Interviewer, Employee), custom roles. Guards prevent: removing/demoting the last admin, changing your own
role, deleting system roles, granting extra permissions to the admin role, company admins changing plan/status/limits.
Requisition/offer approvers cannot approve their own requests (unless Company Admin).

## Business-rule enforcement
Workflow state changes are only possible through SECURITY DEFINER RPCs; guard triggers reject direct API updates of
application stages, offer status, and employee login links. Internal functions (`enqueue_email`, `notify_*`,
`seed_company_defaults`, `claim_email_batch`, `complete_email`) are revoked from `anon`/`authenticated`.

## Public endpoints (no account)
- Careers: `public_company`, `public_jobs`, `public_job` return only safe columns; `public_submit_application` validates
  input server-side, requires a resume previously uploaded into `<company>/incoming/<uuid>/`, rejects duplicates, and is
  rate-limited (5/hour per email, 30/hour per client IP from `x-forwarded-for`). A honeypot field filters bots.
- Anonymous storage access is insert-only into the incoming folder of an existing, careers-enabled company; anon cannot read.
- Offers: 256-bit random token (two v4 UUIDs), only its SHA-256 hash is stored; links expire at the end of the offer's
  expiry date; responses are rate-limited; signature must match the candidate's name; token hash is excluded from audit logs.

## Communication
- Only participants can read conversations, messages, attachments, reactions and typing state (`chat_is_participant`).
- All chat writes go through RPCs (table INSERT/UPDATE/DELETE revoked): users can only edit/delete their own messages,
  only group admins manage membership, DMs only between active members of the same company.
- Attachments live in the private `chat-attachments` bucket under `<company>/<conversation>/…`; storage policies check
  participation; downloads use short-lived signed URLs. File type and size (25 MB) are validated client- and bucket-side.
- Announcements: publish requires `announcements.manage`; department-targeted announcements are visible only to that
  department (and managers).

## Secrets
- Frontend only ever receives the anon key. The service-role key is used solely inside the Edge Function (and in local
  integration tests from a gitignored file). Email provider keys are Edge Function secrets.
- `.env.local` and `supabase/.temp/` are gitignored. **The Supabase personal access token used during setup was shared
  in chat and should be revoked** (Dashboard → Account → Access Tokens).

## Other
- Audit trail on 25 tables with actor, diff and changed fields; sensitive fields are redacted in the UI.
- CSV export neutralizes spreadsheet formula injection; HTML email values are escaped; email previews render in a
  sandboxed iframe.
- Demo mode stores data in the browser only and is not a security boundary (documented in KNOWN_ISSUES.md).
