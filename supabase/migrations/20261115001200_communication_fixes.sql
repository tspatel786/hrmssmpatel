-- =====================================================================
-- 1200  COMMUNICATION FIXES (found during Communication UAT, 2026-11-15)
--
-- A. Realtime tenant isolation. Supabase Realtime cannot apply RLS to DELETE
--    events: every subscriber of a published table receives the primary key of
--    each deleted row, across all companies. Verified live: users of another
--    company received chat_typing_status (conversation_id, user_id) and
--    chat_reactions (message_id, user_id, emoji) DELETE payloads.
--    Fix: published chat tables no longer produce DELETEs on normal use —
--      * typing "stop" sets typing_at to epoch instead of deleting the row;
--      * chat_reactions / chat_participants leave the publication; their changes
--        are signalled by touching chat_conversations (an RLS-checked UPDATE that
--        only participants receive);
--      * announcements leave the publication; changes bump company_realtime_signals
--        (RLS: members of that company only).
--    Remaining published tables: chat_messages (soft-delete only), chat_conversations,
--    chat_typing_status (never deleted in normal use), company_realtime_signals. Their rows
--    are deleted only by ON DELETE CASCADE when a whole company or user account is deleted.
-- B. Storage: chat attachment paths must use the conversation's own company as
--    the first path segment (previously any prefix was accepted on upload).
-- C. Presence: v_chat_directory exposes the presence status (online/away/offline)
--    so the UI no longer shows "Online" for users who went away or closed the app.
-- D. chat_mark_delivered only touches conversations with undelivered messages.
-- =====================================================================

-- ---------- A. realtime isolation ----------
create or replace function public.chat_touch_conversation() returns trigger
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if tg_op = 'DELETE' then v := old.conversation_id; else v := new.conversation_id; end if;
  update public.chat_conversations set updated_at = now() where id = v;
  return null;
end $$;

create trigger trg_chat_reactions_touch after insert or delete on public.chat_reactions
  for each row execute function public.chat_touch_conversation();
create trigger trg_chat_participants_touch_ins_del after insert or delete on public.chat_participants
  for each row execute function public.chat_touch_conversation();
create trigger trg_chat_participants_touch_upd after update on public.chat_participants
  for each row when (old.last_read_at is distinct from new.last_read_at
                     or old.last_delivered_at is distinct from new.last_delivered_at
                     or old.role is distinct from new.role)
  execute function public.chat_touch_conversation();

create or replace function public.chat_set_typing(p_conversation uuid, p_typing boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.chat_require_participant(p_conversation);
  insert into public.chat_typing_status (conversation_id, user_id, typing_at)
  values (p_conversation, auth.uid(), case when p_typing then now() else 'epoch'::timestamptz end)
  on conflict (conversation_id, user_id) do update set typing_at = excluded.typing_at;
end $$;

-- identical to 1100 except the typing reset (update instead of delete)
create or replace function public.chat_send_message(p_conversation uuid, p_body text, p_client_id text default null,
  p_reply_to uuid default null, p_attachments jsonb default '[]'::jsonb) returns public.chat_messages
language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations := public.chat_require_participant(p_conversation); m public.chat_messages; a jsonb;
begin
  if p_client_id is not null then
    select * into m from public.chat_messages where sender_id = auth.uid() and client_id = p_client_id;
    if m.id is not null then return m; end if;
  end if;
  if char_length(coalesce(trim(p_body), '')) = 0 and coalesce(jsonb_array_length(p_attachments), 0) = 0 then
    raise exception 'Message cannot be empty';
  end if;
  if char_length(coalesce(p_body, '')) > 8000 then raise exception 'Message is too long (max 8000 characters)'; end if;
  if coalesce(jsonb_array_length(p_attachments), 0) > 10 then raise exception 'Maximum 10 attachments per message'; end if;
  if p_reply_to is not null and not exists (select 1 from public.chat_messages where id = p_reply_to and conversation_id = p_conversation) then
    raise exception 'Invalid reply target';
  end if;
  insert into public.chat_messages (company_id, conversation_id, sender_id, body, client_id, reply_to_id)
  values (c.company_id, p_conversation, auth.uid(), coalesce(p_body, ''), p_client_id, p_reply_to) returning * into m;
  for a in select * from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    if (a ->> 'path') not like c.company_id::text || '/' || c.id::text || '/%' or (a ->> 'path') like '%..%' then
      raise exception 'Invalid attachment path';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'chat-attachments' and name = a ->> 'path') then
      raise exception 'Attachment upload not found';
    end if;
    insert into public.chat_attachments (company_id, conversation_id, message_id, storage_path, file_name, mime_type, size_bytes)
    values (c.company_id, c.id, m.id, a ->> 'path', left(a ->> 'name', 200), coalesce(a ->> 'mime', 'application/octet-stream'), (a ->> 'size')::bigint);
  end loop;
  update public.chat_conversations set last_message_at = m.created_at where id = c.id;
  update public.chat_participants set last_read_at = m.created_at, last_delivered_at = m.created_at
    where conversation_id = c.id and user_id = auth.uid();
  update public.chat_typing_status set typing_at = 'epoch'::timestamptz
    where conversation_id = c.id and user_id = auth.uid() and typing_at > 'epoch'::timestamptz;
  return m;
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_reactions') then
      alter publication supabase_realtime drop table public.chat_reactions;
    end if;
    if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_participants') then
      alter publication supabase_realtime drop table public.chat_participants;
    end if;
  end if;
end $$;

-- announcements: managers can DELETE them, which would broadcast the announcement id to every tenant. Changes are
-- signalled through a per-company row instead (RLS: members of that company only); the table leaves the publication.
create table public.company_realtime_signals (
  company_id uuid primary key references public.companies(id) on delete cascade,
  announcements_at timestamptz not null default now()
);
alter table public.company_realtime_signals enable row level security;
create policy "members read company signals" on public.company_realtime_signals for select to authenticated
  using (public.is_member(company_id));
revoke insert, update, delete on public.company_realtime_signals from anon, authenticated;
revoke all on public.company_realtime_signals from anon;

create or replace function public.signal_announcements() returns trigger
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if tg_op = 'DELETE' then v := old.company_id; else v := new.company_id; end if;
  insert into public.company_realtime_signals (company_id, announcements_at) values (v, now())
  on conflict (company_id) do update set announcements_at = now();
  return null;
end $$;
create trigger trg_announcements_signal after insert or update or delete on public.announcements
  for each row execute function public.signal_announcements();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'announcements') then
      alter publication supabase_realtime drop table public.announcements;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'company_realtime_signals') then
      alter publication supabase_realtime add table public.company_realtime_signals;
    end if;
  end if;
end $$;

-- ---------- B. storage path must match the conversation's company ----------
create or replace function public.chat_storage_path_ok(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.chat_conversations c
                 where c.id = public.try_uuid(split_part(p_name, '/', 2))
                   and c.company_id = public.storage_company(p_name))
     and public.chat_is_participant(public.try_uuid(split_part(p_name, '/', 2)))
$$;

drop policy if exists "chat participants upload" on storage.objects;
create policy "chat participants upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-attachments' and (
    public.chat_storage_path_ok(name)
    or (split_part(name, '/', 2) = 'announcements' and public.has_permission(public.storage_company(name), 'announcements.manage'))));
drop policy if exists "chat participants read" on storage.objects;
create policy "chat participants read" on storage.objects for select to authenticated
  using (bucket_id = 'chat-attachments' and (
    public.chat_storage_path_ok(name)
    or (split_part(name, '/', 2) = 'announcements' and public.is_member(public.storage_company(name)))));

-- ---------- C. presence status in the directory ----------
create or replace view public.v_chat_directory with (security_invoker = true) as
select m.company_id, m.user_id, coalesce(p.full_name, p.email) as full_name, p.email, r.name as role_name,
  e.employee_code, d.name as department_name, g.title as designation_title, pr.last_seen_at,
  pr.status as presence_status
from public.company_members m
join public.profiles p on p.id = m.user_id
join public.roles r on r.id = m.role_id
left join public.employees e on e.id = m.employee_id
left join public.departments d on d.id = e.department_id
left join public.designations g on g.id = e.designation_id
left join public.chat_user_presence pr on pr.user_id = m.user_id
where m.status = 'active';
revoke all on public.v_chat_directory from anon;

-- ---------- D. delivery receipts without needless writes ----------
create or replace function public.chat_mark_delivered(p_company uuid) returns void
language sql security definer set search_path = public as $$
  update public.chat_participants p set last_delivered_at = now()
  from public.chat_conversations c
  where c.id = p.conversation_id and p.user_id = auth.uid() and p.company_id = p_company
    and p.last_delivered_at < c.last_message_at
    and public.chat_is_active_member(p_company, auth.uid())
$$;
