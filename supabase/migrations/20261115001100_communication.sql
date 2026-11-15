-- =====================================================================
-- 1100  INTERNAL COMMUNICATION (Slack-like): conversations, messages,
--       reactions, attachments, typing, presence, preferences,
--       announcements. Reuses auth.users / profiles / company_members.
-- Read receipts & delivery state are tracked per participant
-- (last_read_at / last_delivered_at) — O(1) per conversation instead of a
-- row per message per reader; chat_message_reads is provided as a view.
-- =====================================================================

insert into public.permissions (key, module, label, sort_order) values
  ('announcements.manage', 'Communication', 'Publish company announcements', 175)
on conflict (key) do nothing;
-- existing companies: HR Managers can publish announcements
insert into public.role_permissions (role_id, permission)
select id, 'announcements.manage' from public.roles where name = 'HR Manager' and is_system
on conflict do nothing;

create table public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  type text not null check (type in ('direct','group')),
  name text check (name is null or char_length(name) between 2 and 80),
  description text check (description is null or char_length(description) <= 500),
  image_url text,
  direct_key text, -- '<min uid>:<max uid>' for direct chats (dedupe)
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (type = 'group' or direct_key is not null),
  check (type = 'direct' or name is not null)
);
create unique index chat_conversations_direct_idx on public.chat_conversations (company_id, direct_key) where type = 'direct';
create index chat_conversations_company_idx on public.chat_conversations (company_id, last_message_at desc);
create trigger trg_chat_conversations_updated before update on public.chat_conversations
  for each row execute function public.set_updated_at();

create table public.chat_participants (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','member')),
  muted boolean not null default false,
  last_read_at timestamptz not null default now(),
  last_delivered_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index chat_participants_user_idx on public.chat_participants (user_id, company_id);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  body text not null default '' check (char_length(body) <= 8000),
  reply_to_id uuid references public.chat_messages(id) on delete set null,
  client_id text check (client_id is null or char_length(client_id) between 8 and 64),
  edited_at timestamptz,
  deleted_at timestamptz,
  pinned_at timestamptz,
  pinned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index chat_messages_conv_idx on public.chat_messages (conversation_id, created_at desc);
create unique index chat_messages_client_idx on public.chat_messages (sender_id, client_id) where client_id is not null;

create table public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  storage_path text not null,
  file_name text not null check (char_length(file_name) between 1 and 200),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  created_at timestamptz not null default now(),
  check (storage_path like company_id::text || '/' || conversation_id::text || '/%')
);
create index chat_attachments_conv_idx on public.chat_attachments (conversation_id, created_at desc);
create index chat_attachments_msg_idx on public.chat_attachments (message_id);

create table public.chat_reactions (
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table public.chat_typing_status (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  typing_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table public.chat_user_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  status text not null default 'online' check (status in ('online','away','offline'))
);

create table public.chat_notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sound_enabled boolean not null default true,
  browser_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 160),
  body text not null check (char_length(body) between 3 and 10000),
  department_id uuid references public.departments(id) on delete set null,
  pinned boolean not null default false,
  requires_ack boolean not null default false,
  attachment_path text,
  attachment_name text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (attachment_path is null or attachment_path like company_id::text || '/announcements/%')
);
create index announcements_company_idx on public.announcements (company_id, pinned desc, created_at desc);
create trigger trg_announcements_updated before update on public.announcements
  for each row execute function public.set_updated_at();
create trigger trg_same_company before insert or update on public.announcements for each row
  execute function public.guard_same_company('department_id:departments');
create trigger trg_audit_announcements after insert or update or delete on public.announcements
  for each row execute function public.audit_trigger();

create table public.announcement_reads (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  read_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  primary key (announcement_id, user_id)
);

-- ---------- helpers ----------
create or replace function public.chat_is_participant(p_conversation uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_participants p
    join public.company_members m on m.company_id = p.company_id and m.user_id = p.user_id and m.status = 'active'
    join public.companies c on c.id = p.company_id and c.status <> 'suspended'
    where p.conversation_id = p_conversation and p.user_id = auth.uid()
  )
$$;

create or replace function public.chat_is_admin(p_conversation uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.chat_participants
                 where conversation_id = p_conversation and user_id = auth.uid() and role = 'admin')
$$;

create or replace function public.chat_require_participant(p_conversation uuid) returns public.chat_conversations
language plpgsql stable security definer set search_path = public as $$
declare c public.chat_conversations;
begin
  if not public.chat_is_participant(p_conversation) then
    raise exception 'You are not a member of this conversation' using errcode = '42501';
  end if;
  select * into c from public.chat_conversations where id = p_conversation;
  return c;
end $$;

create or replace function public.chat_is_active_member(p_company uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.company_members where company_id = p_company and user_id = p_user and status = 'active')
$$;

-- ---------- conversations ----------
create or replace function public.chat_start_direct(p_company uuid, p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_key text; v_id uuid;
begin
  if not public.is_member(p_company) or not public.chat_is_active_member(p_company, auth.uid()) then
    raise exception 'Not a member of this company' using errcode = '42501';
  end if;
  if p_user = auth.uid() then raise exception 'You cannot start a conversation with yourself'; end if;
  if not public.chat_is_active_member(p_company, p_user) then raise exception 'That user is not an active member of this company'; end if;
  v_key := least(auth.uid()::text, p_user::text) || ':' || greatest(auth.uid()::text, p_user::text);
  select id into v_id from public.chat_conversations where company_id = p_company and type = 'direct' and direct_key = v_key;
  if v_id is null then
    insert into public.chat_conversations (company_id, type, direct_key) values (p_company, 'direct', v_key) returning id into v_id;
    insert into public.chat_participants (conversation_id, user_id, company_id, role)
    values (v_id, auth.uid(), p_company, 'member'), (v_id, p_user, p_company, 'member');
  end if;
  return v_id;
end $$;

create or replace function public.chat_create_group(p_company uuid, p_name text, p_description text, p_members uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; u uuid;
begin
  if not public.chat_is_active_member(p_company, auth.uid()) then raise exception 'Not a member of this company' using errcode = '42501'; end if;
  if char_length(coalesce(trim(p_name), '')) < 2 then raise exception 'Group name must be at least 2 characters'; end if;
  if coalesce(array_length(p_members, 1), 0) > 500 then raise exception 'Too many members'; end if;
  insert into public.chat_conversations (company_id, type, name, description) values (p_company, 'group', trim(p_name), nullif(trim(coalesce(p_description, '')), ''))
  returning id into v_id;
  insert into public.chat_participants (conversation_id, user_id, company_id, role) values (v_id, auth.uid(), p_company, 'admin');
  foreach u in array coalesce(p_members, '{}') loop
    if u <> auth.uid() then
      if not public.chat_is_active_member(p_company, u) then raise exception 'All members must belong to this company'; end if;
      insert into public.chat_participants (conversation_id, user_id, company_id) values (v_id, u, p_company) on conflict do nothing;
    end if;
  end loop;
  insert into public.chat_messages (company_id, conversation_id, sender_id, body)
  values (p_company, v_id, null, (select coalesce(full_name, email) from public.profiles where id = auth.uid()) || ' created the group');
  return v_id;
end $$;

create or replace function public.chat_update_group(p_conversation uuid, p_name text, p_description text, p_image_url text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations := public.chat_require_participant(p_conversation);
begin
  if c.type <> 'group' then raise exception 'Only groups can be edited'; end if;
  if not public.chat_is_admin(p_conversation) then raise exception 'Only group admins can edit the group' using errcode = '42501'; end if;
  if char_length(coalesce(trim(p_name), '')) < 2 then raise exception 'Group name must be at least 2 characters'; end if;
  update public.chat_conversations set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''),
    image_url = nullif(p_image_url, '') where id = p_conversation;
end $$;

create or replace function public.chat_add_members(p_conversation uuid, p_members uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations := public.chat_require_participant(p_conversation); u uuid; n integer := 0;
begin
  if c.type <> 'group' then raise exception 'Members can only be added to groups'; end if;
  if not public.chat_is_admin(p_conversation) then raise exception 'Only group admins can add members' using errcode = '42501'; end if;
  foreach u in array coalesce(p_members, '{}') loop
    if not public.chat_is_active_member(c.company_id, u) then raise exception 'All members must belong to this company'; end if;
    insert into public.chat_participants (conversation_id, user_id, company_id) values (p_conversation, u, c.company_id) on conflict do nothing;
    if found then
      n := n + 1;
      insert into public.chat_messages (company_id, conversation_id, sender_id, body)
      values (c.company_id, p_conversation, null, (select coalesce(full_name, email) from public.profiles where id = u) || ' was added to the group');
    end if;
  end loop;
  return n;
end $$;

create or replace function public.chat_remove_member(p_conversation uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations := public.chat_require_participant(p_conversation); v_next uuid;
begin
  if c.type <> 'group' then raise exception 'You cannot leave a direct conversation'; end if;
  if p_user <> auth.uid() and not public.chat_is_admin(p_conversation) then
    raise exception 'Only group admins can remove members' using errcode = '42501';
  end if;
  delete from public.chat_participants where conversation_id = p_conversation and user_id = p_user;
  if not found then raise exception 'User is not a member of this group'; end if;
  insert into public.chat_messages (company_id, conversation_id, sender_id, body)
  values (c.company_id, p_conversation, null, (select coalesce(full_name, email) from public.profiles where id = p_user)
          || case when p_user = auth.uid() then ' left the group' else ' was removed from the group' end);
  -- keep at least one admin
  if not exists (select 1 from public.chat_participants where conversation_id = p_conversation and role = 'admin') then
    select user_id into v_next from public.chat_participants where conversation_id = p_conversation order by joined_at limit 1;
    update public.chat_participants set role = 'admin' where conversation_id = p_conversation and user_id = v_next;
  end if;
end $$;

create or replace function public.chat_set_member_role(p_conversation uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations := public.chat_require_participant(p_conversation);
begin
  if not public.chat_is_admin(p_conversation) then raise exception 'Only group admins can change roles' using errcode = '42501'; end if;
  if p_role not in ('admin','member') then raise exception 'Invalid role'; end if;
  update public.chat_participants set role = p_role where conversation_id = p_conversation and user_id = p_user;
  if p_role = 'member' and not exists (select 1 from public.chat_participants where conversation_id = p_conversation and role = 'admin') then
    raise exception 'A group needs at least one admin';
  end if;
end $$;

create or replace function public.chat_set_muted(p_conversation uuid, p_muted boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.chat_require_participant(p_conversation);
  update public.chat_participants set muted = p_muted where conversation_id = p_conversation and user_id = auth.uid();
end $$;

-- ---------- messages ----------
-- Idempotent send: retries with the same client_id return the original message (no duplicates).
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
  delete from public.chat_typing_status where conversation_id = c.id and user_id = auth.uid();
  return m;
end $$;

create or replace function public.chat_edit_message(p_message uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.chat_messages;
begin
  select * into m from public.chat_messages where id = p_message;
  if m.id is null then raise exception 'Message not found'; end if;
  perform public.chat_require_participant(m.conversation_id);
  if m.sender_id is distinct from auth.uid() then raise exception 'You can only edit your own messages' using errcode = '42501'; end if;
  if m.deleted_at is not null then raise exception 'Deleted messages cannot be edited'; end if;
  if char_length(coalesce(trim(p_body), '')) = 0 or char_length(p_body) > 8000 then raise exception 'Message must be 1–8000 characters'; end if;
  update public.chat_messages set body = p_body, edited_at = now() where id = p_message;
end $$;

create or replace function public.chat_delete_message(p_message uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.chat_messages;
begin
  select * into m from public.chat_messages where id = p_message;
  if m.id is null then raise exception 'Message not found'; end if;
  perform public.chat_require_participant(m.conversation_id);
  if m.sender_id is distinct from auth.uid() then raise exception 'You can only delete your own messages' using errcode = '42501'; end if;
  update public.chat_messages set body = '', deleted_at = now(), pinned_at = null, pinned_by = null where id = p_message;
  delete from public.chat_reactions where message_id = p_message;
  delete from public.chat_attachments where message_id = p_message;
end $$;

create or replace function public.chat_toggle_pin(p_message uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare m public.chat_messages;
begin
  select * into m from public.chat_messages where id = p_message;
  if m.id is null then raise exception 'Message not found'; end if;
  perform public.chat_require_participant(m.conversation_id);
  if m.deleted_at is not null then raise exception 'Deleted messages cannot be pinned'; end if;
  update public.chat_messages set pinned_at = case when pinned_at is null then now() end,
    pinned_by = case when pinned_at is null then auth.uid() end where id = p_message;
  return m.pinned_at is null;
end $$;

create or replace function public.chat_toggle_reaction(p_message uuid, p_emoji text) returns boolean
language plpgsql security definer set search_path = public as $$
declare m public.chat_messages;
begin
  select * into m from public.chat_messages where id = p_message;
  if m.id is null or m.deleted_at is not null then raise exception 'Message not found'; end if;
  perform public.chat_require_participant(m.conversation_id);
  if char_length(coalesce(p_emoji, '')) not between 1 and 16 then raise exception 'Invalid emoji'; end if;
  delete from public.chat_reactions where message_id = p_message and user_id = auth.uid() and emoji = p_emoji;
  if found then return false; end if;
  insert into public.chat_reactions (message_id, user_id, conversation_id, emoji) values (p_message, auth.uid(), m.conversation_id, p_emoji);
  return true;
end $$;

create or replace function public.chat_mark_read(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.chat_require_participant(p_conversation);
  update public.chat_participants set last_read_at = greatest(last_read_at, now()), last_delivered_at = greatest(last_delivered_at, now())
  where conversation_id = p_conversation and user_id = auth.uid();
end $$;

-- marks every conversation of the user in a company as delivered (called when the client receives updates)
create or replace function public.chat_mark_delivered(p_company uuid) returns void
language sql security definer set search_path = public as $$
  update public.chat_participants set last_delivered_at = now()
  where user_id = auth.uid() and company_id = p_company and public.chat_is_active_member(p_company, auth.uid())
$$;

create or replace function public.chat_set_typing(p_conversation uuid, p_typing boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.chat_require_participant(p_conversation);
  if p_typing then
    insert into public.chat_typing_status (conversation_id, user_id, typing_at) values (p_conversation, auth.uid(), now())
    on conflict (conversation_id, user_id) do update set typing_at = now();
  else
    delete from public.chat_typing_status where conversation_id = p_conversation and user_id = auth.uid();
  end if;
end $$;

create or replace function public.chat_heartbeat(p_status text default 'online') returns void
language sql security definer set search_path = public as $$
  insert into public.chat_user_presence (user_id, last_seen_at, status)
  select auth.uid(), now(), case when p_status in ('online','away','offline') then p_status else 'online' end
  where auth.uid() is not null
  on conflict (user_id) do update set last_seen_at = now(), status = excluded.status
$$;

-- Conversation list for the sidebar: unread counts, last message preview, DM partner, presence.
create or replace function public.chat_my_conversations(p_company uuid)
returns table (id uuid, type text, name text, description text, image_url text, last_message_at timestamptz, muted boolean,
  my_role text, unread_count bigint, last_message_id uuid, last_message_body text, last_message_sender uuid, last_message_sender_name text,
  last_message_has_attachments boolean, other_user_id uuid, other_user_name text, other_user_email text, other_last_seen timestamptz,
  member_count bigint)
language sql stable security definer set search_path = public as $$
  select c.id, c.type,
    case when c.type = 'direct' then coalesce(op.full_name, op.email) else c.name end,
    c.description, c.image_url, c.last_message_at, me.muted, me.role,
    (select count(*) from public.chat_messages m where m.conversation_id = c.id and m.created_at > me.last_read_at
       and m.sender_id is distinct from auth.uid() and m.deleted_at is null),
    lm.id, case when lm.deleted_at is not null then 'Message deleted' else left(lm.body, 140) end, lm.sender_id,
    coalesce(sp.full_name, sp.email), exists (select 1 from public.chat_attachments a where a.message_id = lm.id),
    o.user_id, coalesce(op.full_name, op.email), op.email, pr.last_seen_at,
    (select count(*) from public.chat_participants x where x.conversation_id = c.id)
  from public.chat_participants me
  join public.chat_conversations c on c.id = me.conversation_id
  left join lateral (select * from public.chat_messages m where m.conversation_id = c.id order by m.created_at desc limit 1) lm on true
  left join public.profiles sp on sp.id = lm.sender_id
  left join lateral (select p.user_id from public.chat_participants p where c.type = 'direct' and p.conversation_id = c.id and p.user_id <> auth.uid() limit 1) o on true
  left join public.profiles op on op.id = o.user_id
  left join public.chat_user_presence pr on pr.user_id = o.user_id
  where me.user_id = auth.uid() and me.company_id = p_company and public.chat_is_active_member(p_company, auth.uid())
  order by c.last_message_at desc
$$;

-- ---------- announcements ----------
create or replace function public.can_see_announcement(p_company uuid, p_department uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(p_company) and (
    p_department is null or public.has_permission(p_company, 'announcements.manage')
    or exists (select 1 from public.employees e where e.id = public.my_employee_id(p_company) and e.department_id = p_department))
$$;

create or replace function public.announcement_acknowledge(p_announcement uuid, p_ack boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare a public.announcements;
begin
  select * into a from public.announcements where id = p_announcement;
  if a.id is null or not public.can_see_announcement(a.company_id, a.department_id) then raise exception 'Announcement not found'; end if;
  insert into public.announcement_reads (announcement_id, user_id, company_id, read_at, acknowledged_at)
  values (a.id, auth.uid(), a.company_id, now(), case when p_ack then now() end)
  on conflict (announcement_id, user_id) do update set acknowledged_at = coalesce(public.announcement_reads.acknowledged_at, excluded.acknowledged_at);
end $$;

create or replace function public.on_announcement_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (company_id, user_id, type, title, body, link)
  select new.company_id, m.user_id, 'announcement', 'New announcement: ' || new.title, left(new.body, 140), '/app/communication?view=announcements'
  from public.company_members m
  where m.company_id = new.company_id and m.status = 'active' and m.user_id is distinct from new.created_by
    and (new.department_id is null or exists (select 1 from public.employees e where e.id = m.employee_id and e.department_id = new.department_id));
  return new;
end $$;
create trigger trg_announcement_notify after insert on public.announcements
  for each row execute function public.on_announcement_created();

-- ---------- views ----------
create view public.v_chat_directory with (security_invoker = true) as
select m.company_id, m.user_id, coalesce(p.full_name, p.email) as full_name, p.email, r.name as role_name,
  e.employee_code, d.name as department_name, g.title as designation_title, pr.last_seen_at
from public.company_members m
join public.profiles p on p.id = m.user_id
join public.roles r on r.id = m.role_id
left join public.employees e on e.id = m.employee_id
left join public.departments d on d.id = e.department_id
left join public.designations g on g.id = e.designation_id
left join public.chat_user_presence pr on pr.user_id = m.user_id
where m.status = 'active';

create view public.v_chat_messages with (security_invoker = true) as
select m.*, coalesce(p.full_name, p.email) as sender_name,
  coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'path', a.storage_path, 'name', a.file_name, 'mime', a.mime_type, 'size', a.size_bytes))
            from public.chat_attachments a where a.message_id = m.id), '[]') as attachments,
  coalesce((select jsonb_agg(jsonb_build_object('emoji', x.emoji, 'count', x.n, 'users', x.users))
            from (select emoji, count(*) n, array_agg(user_id) users from public.chat_reactions r where r.message_id = m.id group by emoji) x), '[]') as reactions,
  (select jsonb_build_object('id', rm.id, 'body', case when rm.deleted_at is null then left(rm.body, 160) else 'Message deleted' end,
          'sender_name', coalesce(rp.full_name, rp.email))
   from public.chat_messages rm left join public.profiles rp on rp.id = rm.sender_id where rm.id = m.reply_to_id) as reply_to
from public.chat_messages m
left join public.profiles p on p.id = m.sender_id;

create view public.v_chat_attachments with (security_invoker = true) as
select a.*, m.sender_id, coalesce(p.full_name, p.email) as sender_name,
  case when c.type = 'group' then c.name else 'Direct message' end as conversation_name
from public.chat_attachments a
join public.chat_messages m on m.id = a.message_id
join public.chat_conversations c on c.id = a.conversation_id
left join public.profiles p on p.id = m.sender_id;

-- per-message read receipts derived from participant cursors
create view public.chat_message_reads with (security_invoker = true) as
select m.id as message_id, p.user_id, p.last_read_at as read_at
from public.chat_messages m
join public.chat_participants p on p.conversation_id = m.conversation_id and p.user_id is distinct from m.sender_id
where p.last_read_at >= m.created_at;

create view public.v_announcements with (security_invoker = true) as
select a.*, coalesce(p.full_name, p.email) as author_name, d.name as department_name,
  (select count(*) from public.announcement_reads r where r.announcement_id = a.id and r.acknowledged_at is not null) as ack_count,
  (select r.acknowledged_at from public.announcement_reads r where r.announcement_id = a.id and r.user_id = auth.uid()) as my_ack_at
from public.announcements a
left join public.profiles p on p.id = a.created_by
left join public.departments d on d.id = a.department_id;

-- ---------- RLS ----------
alter table public.chat_conversations enable row level security;
alter table public.chat_participants enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_attachments enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.chat_typing_status enable row level security;
alter table public.chat_user_presence enable row level security;
alter table public.chat_notification_preferences enable row level security;
alter table public.announcements enable row level security;
alter table public.announcement_reads enable row level security;

create policy "participants read conversations" on public.chat_conversations for select to authenticated using (public.chat_is_participant(id));
create policy "participants read members" on public.chat_participants for select to authenticated using (public.chat_is_participant(conversation_id));
create policy "participants read messages" on public.chat_messages for select to authenticated using (public.chat_is_participant(conversation_id));
create policy "participants read attachments" on public.chat_attachments for select to authenticated using (public.chat_is_participant(conversation_id));
create policy "participants read reactions" on public.chat_reactions for select to authenticated using (public.chat_is_participant(conversation_id));
create policy "participants read typing" on public.chat_typing_status for select to authenticated using (public.chat_is_participant(conversation_id));
create policy "colleagues read presence" on public.chat_user_presence for select to authenticated using (public.shares_company(user_id));
create policy "own notification prefs" on public.chat_notification_preferences for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "members read announcements" on public.announcements for select to authenticated using (public.can_see_announcement(company_id, department_id));
create policy "managers write announcements" on public.announcements for all to authenticated
  using (public.has_permission(company_id, 'announcements.manage')) with check (public.has_permission(company_id, 'announcements.manage'));
create policy "read own or managed announcement reads" on public.announcement_reads for select to authenticated
  using (user_id = auth.uid() or public.has_permission(company_id, 'announcements.manage'));

-- all chat writes go through the RPCs above
revoke insert, update, delete on public.chat_conversations, public.chat_participants, public.chat_messages, public.chat_attachments,
  public.chat_reactions, public.chat_typing_status, public.chat_user_presence, public.announcement_reads from anon, authenticated;
revoke all on public.chat_conversations, public.chat_participants, public.chat_messages, public.chat_attachments, public.chat_reactions,
  public.chat_typing_status, public.chat_user_presence, public.chat_notification_preferences, public.announcements,
  public.announcement_reads, public.v_chat_directory, public.v_chat_messages, public.v_chat_attachments, public.chat_message_reads,
  public.v_announcements from anon;

-- ---------- storage: private chat attachments ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('chat-attachments', 'chat-attachments', false, 26214400, array[
    'image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','text/csv',
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/zip'])
on conflict (id) do nothing;

-- path: <company_id>/<conversation_id>/<uuid>/<file>  or  <company_id>/announcements/<uuid>/<file>
create policy "chat participants upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-attachments' and (
    public.chat_is_participant(public.try_uuid(split_part(name, '/', 2)))
    or (split_part(name, '/', 2) = 'announcements' and public.has_permission(public.storage_company(name), 'announcements.manage'))));
create policy "chat participants read" on storage.objects for select to authenticated
  using (bucket_id = 'chat-attachments' and (
    public.chat_is_participant(public.try_uuid(split_part(name, '/', 2)))
    or (split_part(name, '/', 2) = 'announcements' and public.is_member(public.storage_company(name)))));
create policy "announcement managers delete files" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-attachments' and split_part(name, '/', 2) = 'announcements'
         and public.has_permission(public.storage_company(name), 'announcements.manage'));

-- ---------- realtime (Supabase only; skipped where the publication does not exist) ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.chat_messages, public.chat_participants, public.chat_reactions,
      public.chat_typing_status, public.chat_conversations, public.announcements;
  end if;
end $$;
