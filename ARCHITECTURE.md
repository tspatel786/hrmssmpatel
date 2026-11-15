# Architecture

```
React SPA (Vite, lazy routes)
 ├─ contexts/session.tsx   auth user, active company, permission set (my_permissions RPC)
 ├─ contexts/chat.tsx      realtime inbox, unread counts, presence heartbeat, sound/browser notifications
 ├─ lib/hooks.ts           useList/useRpc/useAction/useTable (TanStack Query)
 └─ lib/backend/           Backend interface — the UI never talks to Supabase directly
     ├─ supabase.ts        supabase-js: PostgREST, Auth, Storage, Realtime, Edge Function invoke
     └─ local/             PGlite (Postgres WASM) running the same migrations, local auth/storage/email worker
Supabase
 ├─ Postgres: tables + RLS + SECURITY DEFINER RPCs (business rules) + triggers (automation, audit)
 ├─ Storage: resumes, documents, chat-attachments (private) · company-assets (public logos)
 ├─ Realtime: chat_* tables + announcements (postgres_changes, RLS-filtered)
 └─ Edge Function process-emails: drains email_logs queue (mock | Resend), service role only server-side
```

## Key design decisions

- **Business logic in Postgres.** Workflow transitions (stage changes, interview scheduling, offer approval/sending,
  acceptance, onboarding → employee, leave, payroll) are `SECURITY DEFINER` RPCs that validate permissions and invariants.
  Guard triggers block bypassing them through direct table writes (`is_api_role()`).
- **One logic implementation, two runtimes.** Demo mode executes the identical migrations in PGlite with `SET ROLE` + JWT
  claims per transaction, so RLS and RPCs behave exactly as on Supabase. Tests run the same way in Node.
- **Email = transactional outbox.** Triggers/RPCs render templates into `email_logs` inside the same transaction as the
  business change (so mail is only queued when the change commits); a unique `(company_id, dedupe_key)` prevents duplicates.
  Delivery is server-side (Edge Function) and only marked `sent` after the provider confirms.
- **Read views use `security_invoker`** so they inherit the caller's RLS.
- **Chat delivery is idempotent.** Messages carry a client-generated `client_id` (unique per sender); retries return the
  original row. The client treats realtime events as "refetch" signals and de-duplicates optimistic messages by `client_id`.
  Read receipts are per-participant cursors (`last_read_at`, `last_delivered_at`) instead of a row per message per reader.
- **Notifications de-duplicated across tabs** via the Web Locks API + a shared "notified message ids" set; the chime is
  synthesized with the Web Audio API after the first user gesture (autoplay rules).

## Route map

Public: `/`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/careers/:slug`, `/careers/:slug/jobs/:jobId`,
`/offer/:token`. App: `/app/*` (dashboard, recruitment, offers, onboarding, employees, organization, attendance, leave,
payroll, reports, emails, audit, settings, notifications, communication, profile). Platform: `/admin`.
