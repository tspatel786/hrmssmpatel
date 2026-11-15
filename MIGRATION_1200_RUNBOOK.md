# Runbook: apply migration 1200 (Communication cross-company Realtime fix)

**Status (final audit, 2026-11-15):** migrations 1200, 1300 and 1400 **are applied** to the Supabase project (applied by the
project owner; verified read-only: `company_realtime_signals`, `v_chat_directory.presence_status`, `attendance_corrections`,
`offer_templates` exist). Acceptance test `tests/supabase/realtime.test.ts`: **4 / 4 PASS**, including "another company receives
no chat payloads at all, including DELETE events". The leak is **fixed in the live environment**. The steps below remain the
procedure for any other environment (staging, a new project).

## What it fixes

Supabase Realtime does not apply RLS to `DELETE` events. Every authenticated subscriber of a published table receives the
primary key of each deleted row, **from every company**. Verified live (`tests/supabase/realtime.test.ts`): a user of
another company received

| Table | Leaked on | Payload |
|---|---|---|
| `chat_typing_status` | someone stops typing / sends | `conversation_id`, `user_id` |
| `chat_reactions` | a reaction is removed | `message_id`, `user_id`, `emoji` |
| `chat_participants` | a member leaves / is removed | `conversation_id`, `user_id` |
| `announcements` | an announcement is deleted | `id` |

No message text, file or announcement content leaked: direct reads, RPC writes and storage access across companies are
refused (verified live in the same test file). The leak is conversation-membership metadata (who talks to whom).

Migration `20261115001200_communication_fixes.sql`:
- typing "stop" updates `typing_at` to epoch instead of deleting;
- removes `chat_reactions`, `chat_participants`, `announcements` from `supabase_realtime`; their changes are signalled by
  RLS-checked UPDATEs (`chat_conversations.updated_at`, new `company_realtime_signals` row per company);
- storage: chat attachment paths must start with the conversation's own company id (upload + read policies);
- `v_chat_directory.presence_status`; `chat_mark_delivered` only writes when needed.
No table is dropped, no data is deleted, no existing RLS policy is loosened (the two storage policies are replaced with
stricter versions).

## Order matters

1. **Deploy the new frontend first.** The pre-1200 frontend (any build from before this branch, including one
   built from `cbf2caa`) subscribes to all chat tables on one Realtime channel. After the migration three of those
   tables are no longer published, and Supabase then delivers *nothing* on such a channel (verified live with a probe).
   The new frontend uses one channel per table and was verified live against the current (pre-1200) schema. It also
   subscribes to the new signal table. If no frontend is deployed against this project yet, this step is a no-op.
   **Confirm the new build is live before step 2:** in the browser devtools Network → WS tab, the Communication page
   opens one Realtime channel per table (`chat-<company>-chat_messages-…`, `…-company_realtime_signals-…`, etc.)
   rather than a single `chat-<company>-<random>` channel carrying every table.
2. Then apply migration 1200 (`--only`, below). **Do not** use `npm run db:apply` / `supabase db push` here: they would
   also apply 1300 and 1400 in the same run.
3. Then run the live tests.
4. Apply 1300 and 1400 separately afterwards (`--only 20261115001300`, then `--only 20261115001400`). 1300 backfills
   the late/early flags with one `UPDATE` over every `attendance_records` row inside its transaction; clock-in/out
   writes wait until it commits. Apply it outside working hours if that table is large.

## Steps

```bash
# 0. Backup: Supabase Dashboard → Database → Backups (confirm a recent backup exists),
#    or: pg_dump "$DATABASE_URL" --schema=public --schema=storage -Fc -f backup-before-1200.dump

# 1. Use a fresh personal access token (the old one was exposed in chat — revoke it first).
export SUPABASE_ACCESS_TOKEN=sbp_...            # Dashboard → Account → Access tokens
export SUPABASE_PROJECT_REF=ivtkeglfocvoyhcrpmfl # talentflow-hrms

# 2. See what is pending (no changes are made)
node scripts/supabase-apply.mjs --dry-run
#    expected: skip 0100…1100, would apply 1200, 1300, 1400

# 3. Apply ONLY migration 1200 (one transaction; refuses if an earlier migration is pending)
node scripts/supabase-apply.mjs --only 20261115001200
```

### Verify in the SQL editor

```sql
-- published tables: must be exactly these four
select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
-- chat_conversations | chat_messages | chat_typing_status | company_realtime_signals

-- RLS is enabled on the new table and it has only a member-read policy
select relrowsecurity from pg_class where oid = 'public.company_realtime_signals'::regclass;   -- t
select policyname, cmd from pg_policies where tablename = 'company_realtime_signals';           -- members read company signals | SELECT

-- storage policies were replaced with the stricter path check
select policyname, cmd from pg_policies where schemaname = 'storage' and policyname like 'chat participants%';
```

### Acceptance test (required before calling the issue fixed)

```bash
npm run test:live
# tests/supabase/realtime.test.ts must show 4/4 passing, in particular:
#   "another company receives no chat payloads at all, including DELETE events (requires migration 1200)"
SUPABASE_LIVE=1 npx playwright test --project=supabase   # Communication E2E, 3/3
```

## Rollback (re-opens the leak — only if the migration breaks something)

```sql
begin;
alter publication supabase_realtime add table public.chat_reactions, public.chat_participants, public.announcements;
alter publication supabase_realtime drop table public.company_realtime_signals;
commit;
```
Functions/policies from 1200 can stay in place during a rollback; they are compatible with the old frontend except for
realtime delivery, which the publication change above restores. Restore from the backup for a full revert.

Verify the rollback: the publication query above must list `announcements, chat_conversations, chat_messages,
chat_participants, chat_reactions, chat_typing_status` (and no `company_realtime_signals`).

### Frontend rollback ordering

| Migration 1200 state | Rolling the frontend back to a pre-1200 build |
|---|---|
| Not applied | Safe at any time (redeploy the previous build). |
| Applied | **Run the SQL rollback above first**, verify it, then redeploy the old build. The reverse order leaves the old frontend with no realtime events at all (silent: no error is shown). |

The new frontend never needs to be rolled back because of the migration: it works on both schemas. See
`DEPLOYMENT.md` section 6 for the full rollback matrix.

## Residual (documented, not fixed)

Rows of the four published tables are still deleted by `ON DELETE CASCADE` when an entire company or user account is
deleted; those deletes broadcast primary keys once. This only happens on account/company deletion by an administrator.
