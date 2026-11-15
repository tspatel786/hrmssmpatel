# Communication Module — UAT Report

**Date:** 2026-11-15 · **Scope:** existing Slack-style Communication module (not rebuilt) · **Build:** working tree on `main` after `cbf2caa`

Every feature was checked against the frontend code (`src/contexts/chat.tsx`, `src/lib/chatNotify.ts`,
`src/pages/app/communication/*`), the migrations (`20261115001100_communication.sql`, new `20261115001200_communication_fixes.sql`),
RLS/storage policies and the Realtime implementation (`src/lib/backend/supabase.ts`). A feature is marked **PASS** only when
an automated test exercised it end to end (evidence column). Nothing is marked PASS from code reading alone.

## Test environments

| Env | What it is | Command |
|---|---|---|
| **DB** | Real migrations in Postgres (PGlite), RLS enforced per call, same data adapter as the app | `npx vitest run tests/db/communication.test.ts` |
| **LIVE-RT** | Real Supabase project: Auth + PostgREST + **Realtime websocket** + RLS, from Node | `SUPABASE_LIVE=1 npx vitest run tests/supabase/realtime.test.ts` |
| **LIVE-E2E** | Real Supabase + production build in Chromium, several browser contexts (different users), real Realtime | `SUPABASE_LIVE=1 npx playwright test --project=supabase` |

Live tests use admin-created, pre-confirmed throwaway users and companies on the dedicated `talentflow-hrms` project and delete
everything afterwards. No real emails are sent.

## Results

| # | Feature | Status | Evidence | Notes |
|---|---|---|---|---|
| 1 | Direct messaging between HRMS users | **PASS** | DB: DM dedupe, same-company rule, idempotent send · LIVE-E2E: Anna → Ben via UI, reply back | One DM per pair (`direct_key`), only active members of the same company |
| 2 | Group conversations | **PASS** | DB: create, admin-only add/remove, leave, admin auto-promotion, mute · LIVE-E2E: create "Launch Squad" in UI, member receives it; group photo upload + rename | **Fixed:** group photo had no UI (now upload/change in Details); editing a group's name sent `p_image_url = null` and would have erased the photo |
| 3 | Real-time message delivery | **PASS** | LIVE-RT: participant receives the INSERT over the websocket (≈ 0.56 s measured) · LIVE-E2E: messages, replies, attachments appear without reload | Reconnect → resync is implemented (`RESYNC` on re-subscribe / `online`) |
| 4 | Incoming message notification sound | **PASS** | LIVE-E2E: chime counted (`__hrmsChimeCount`) on incoming message; **no** chime for muted conversation; exactly **one** chime across two tabs (Web Locks dedupe) | Web Audio synthesized chime; browsers require one user gesture first (documented in Settings) |
| 5 | Browser notifications | **PASS** | LIVE-E2E: user enables them in Settings, leaves chat, tab unfocused → A's message creates a notification with title "Anna Admin" and the message body | Verified with a `Notification` stub (headless Chromium cannot display OS notifications); real OS display depends on browser/OS permission |
| 6 | Unread message counts | **PASS** | DB: `unread_count` 2 → 0 after read · LIVE-E2E: sidebar badge "1 unread messages" appears in real time | Muted conversations are excluded from the sidebar total |
| 7 | Read receipts | **PASS** | DB: `chat_message_reads` 0 → 2 after `chat_mark_read` · LIVE-RT: receipt change reaches the sender · LIVE-E2E: sender's receipt turns to "Read" | **Fixed:** messages that arrived while the tab was hidden stayed unread after returning to the open chat (now re-marked on `visibilitychange`) |
| 8 | Attachments | **PASS** | DB: participant upload/attach, non-participant upload & read blocked, foreign path rejected · LIVE-E2E: PDF sent and visible to recipient; outsider cannot list the company folder | **Fixed (security):** storage accepted uploads whose first path segment was *another company's* id (now must equal the conversation's company) |
| 9 | Emoji reactions | **PASS** | DB: toggle, aggregated counts · LIVE-RT: reaction change reaches participant · LIVE-E2E: Ben reacts 👍 in UI → Anna sees "👍 1" live | **Fixed (mobile):** action toolbar was hover-only; message rows are now focusable so tap/keyboard opens it (LIVE-E2E mobile tap test) |
| 10 | Pinned messages | **PASS** | DB: toggle pin · LIVE-E2E: Ben pins → appears in Anna's "Pinned messages" panel | Any participant can pin; deleted messages cannot be pinned |
| 11 | Online presence and typing indicators | **PASS** | DB: presence visible to colleagues only, typing to participants only, presence status exposed · LIVE-RT: typing reaches participant · LIVE-E2E: "Online" shown; "Anna is typing…" appears, clears when draft is emptied, and **expires on its own** | **Fixed:** typing indicator stayed visible indefinitely after the typist stopped (no event triggered a re-render); clearing the draft / leaving the chat did not clear it; users who closed the app still showed "Online" for up to 75 s and `away/offline` status was ignored. Presence remains heartbeat-based (30 s) |
| 12 | Announcements | **PASS** | DB: only `announcements.manage` can publish, department targeting, acks, in-app notification · LIVE-E2E: admin publishes with acknowledgement → employee notified, cannot publish, acknowledges → admin sees "1 acknowledged" | |
| 13 | Mobile responsive chat UI | **PASS** | LIVE-E2E (Pixel 7): list → conversation → back, single pane, composer in viewport, no horizontal scroll, tap opens message actions, send from phone (re-run 2026-11-15 with the per-table Realtime client: 3/3 PASS) | **Fixed:** height used `100vh` (composer could sit under the mobile browser toolbar); now `100dvh` where supported |
| 14 | Cross-company data isolation | **PASS (live, final audit 2026-11-15)** — migration 1200 applied; LIVE-RT 4 / 4 incl. DELETE events. (Was FAIL before 1200.) | LIVE-RT (re-run after the security review): company B **cannot** read any chat table/view (12 checked), call any chat write RPC (10 checked), or list/download/sign/upload company A storage objects — PASS. DB: same checks + regression tests for every fix — PASS. LIVE-E2E: outsider sees no people/conversations, direct URL shows nothing — PASS. LIVE-RT "no payloads incl. DELETE events" — **FAIL**: company B received DELETE primary keys from `chat_typing_status` (conversation_id, user_id), `chat_reactions` (message_id, user_id, emoji), `chat_participants` (conversation_id, user_id) and `announcements` (id) | Root cause: Supabase Realtime does not evaluate RLS for DELETE events, so every subscriber of a published table gets the deleted row's primary key. No message text, files or announcement content leak. Fix: migration 1200 (amended during the security review to also cover `announcements`). Applied to Supabase; the LIVE-RT acceptance test passed 4 / 4 in the final audit (2026-11-15). Also covered offline by `tests/db/isolation_catalog.test.ts` (publication holds exactly the 4 safe tables) |

**Summary (final audit 2026-11-15):** 14 PASS · 0 FAIL · 0 NOT IMPLEMENTED. (#14 was FAIL until migration 1200 was applied.)

## Bugs fixed in this UAT

| Severity | Bug | Fix |
|---|---|---|
| High (security) — **fixed in live** (1200 applied; LIVE-RT 4 / 4) | Realtime DELETE events leaked chat metadata (UUIDs) across companies (typing, reactions, participants, announcements) | Migration 1200: typing reset by UPDATE; `chat_reactions`, `chat_participants`, `announcements` removed from `supabase_realtime`; changes signalled via RLS-checked `chat_conversations` / `company_realtime_signals` UPDATEs |
| High (reliability, found in security review) | A Realtime channel that names any missing/unpublished table silently delivers no events (verified live); applying 1200 under the old client would have stopped all chat realtime | `createRealtime` now opens one channel per table; verified live pre-1200 (3/3 Communication E2E) |
| Medium (security) | Chat uploads accepted another company's id as the path prefix | Migration 1200: `chat_storage_path_ok()` used by upload/read storage policies |
| Medium | Typing indicator never disappeared after the typist stopped (Supabase mode) | `ChatWindow`: 1 s re-render while someone is typing; send `typing=false` when draft is cleared or chat is left |
| Medium | Messages received while the tab was hidden were not marked read on return | `ChatWindow`: mark read on `visibilitychange` |
| Low | Presence: closed tabs stayed "Online", `away/offline` ignored | `pagehide` → offline heartbeat; `isOnline()` honours status; directory refresh 30 s; `v_chat_directory.presence_status` |
| Low | Editing a group's name erased its photo | Keep `image_url` when saving |
| Low | Message actions unreachable on touch devices | Focusable message rows (`focus-within`) |
| Low | Mobile chat height used `100vh` | `100dvh` where supported |
| Low | `chat_mark_delivered` rewrote every conversation on each incoming message | Only conversations with undelivered messages |

Gap closed: **group photo upload UI** (previously listed in KNOWN_ISSUES).

## Remaining limitations (not defects)
- Presence is heartbeat-based (online = heartbeat within 75 s, refreshed every 30 s), not Supabase Presence channels.
- Browser notifications only fire while an HRMS tab is open (no service-worker push).
- Demo mode runs one database per browser tab; realtime between users is verifiable only in Supabase mode.
- Company or user-account deletion cascades still broadcast primary keys of the four published tables once (administrator action only).

## Test runs (this UAT)
See the "Latest run" section of `UAT_REPORT.md`. Demo-mode E2E could not complete on this machine (boot timeouts, reproduced on the pre-branch commit); all Communication evidence above comes from DB, live Realtime and live Supabase E2E runs.
