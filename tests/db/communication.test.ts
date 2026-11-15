// @vitest-environment node
// Internal communication: DMs, groups, receipts, reactions, attachments, announcements, isolation.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, sql, uploadAs } from './harness';

let pg: PGlite;
let a: string, b: string, c: string, outsider: string, rival: string;
let company: string, rivalCompany: string, dm: string, group: string;
const db = (u: string) => clientFor(pg, u);

beforeAll(async () => {
  pg = await createTestDb();
  a = await createUser(pg, 'alice@co.test', 'Alice HR');
  b = await createUser(pg, 'bob@co.test', 'Bob Employee');
  c = await createUser(pg, 'cara@co.test', 'Cara Employee');
  outsider = await createUser(pg, 'oscar@co.test', 'Oscar Same Company');
  rival = await createUser(pg, 'rita@rival.test', 'Rita Rival');
  company = await db(a).rpc<string>('create_company', { p_name: 'Chat Co', p_slug: 'chat-co' });
  rivalCompany = await db(rival).rpc<string>('create_company', { p_name: 'Rival Co', p_slug: 'rival-co' });
  const [emp] = await sql<{ id: string }>(pg, `select id from roles where company_id = $1 and name = 'Employee'`, [company]);
  for (const e of ['bob@co.test', 'cara@co.test', 'oscar@co.test']) await db(a).rpc('invite_member', { p_company: company, p_email: e, p_role: emp.id });
});

describe('Direct messages', () => {
  it('starts one DM per pair (deduplicated) and only with same-company members', async () => {
    dm = await db(a).rpc<string>('chat_start_direct', { p_company: company, p_user: b });
    expect(await db(b).rpc<string>('chat_start_direct', { p_company: company, p_user: a })).toBe(dm);
    await expect(db(a).rpc('chat_start_direct', { p_company: company, p_user: rival })).rejects.toThrow(/not an active member/);
    await expect(db(a).rpc('chat_start_direct', { p_company: company, p_user: a })).rejects.toThrow(/yourself/);
    await expect(db(rival).rpc('chat_start_direct', { p_company: company, p_user: a })).rejects.toThrow(/Not a member/);
  });

  it('sends idempotently (client_id) and tracks unread counts', async () => {
    const m1 = await db(a).rpc<{ id: string }>('chat_send_message', { p_conversation: dm, p_body: 'Hi Bob 👋', p_client_id: 'client-0001' });
    const again = await db(a).rpc<{ id: string }>('chat_send_message', { p_conversation: dm, p_body: 'Hi Bob 👋', p_client_id: 'client-0001' });
    expect(m1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(again.id).toBe(m1.id);
    await db(a).rpc('chat_send_message', { p_conversation: dm, p_body: 'Do you have a minute?', p_client_id: 'client-0002' });
    const list = await db(b).rpc<{ id: string; unread_count: number; other_user_name: string; last_message_body: string }[]>('chat_my_conversations', { p_company: company });
    expect(list[0]).toMatchObject({ id: dm, unread_count: 2, other_user_name: 'Alice HR', last_message_body: 'Do you have a minute?' });
    await expect(db(a).rpc('chat_send_message', { p_conversation: dm, p_body: '   ' })).rejects.toThrow(/empty/);
  });

  it('read receipts update when the recipient opens the conversation', async () => {
    expect((await db(a).list({ table: 'chat_message_reads', filters: [{ column: 'user_id', op: 'eq', value: b }] })).count).toBe(0);
    await db(b).rpc('chat_mark_read', { p_conversation: dm });
    expect((await db(a).list({ table: 'chat_message_reads', filters: [{ column: 'user_id', op: 'eq', value: b }] })).count).toBe(2);
    const list = await db(b).rpc<{ unread_count: number }[]>('chat_my_conversations', { p_company: company });
    expect(list[0].unread_count).toBe(0);
  });

  it('only participants can read; other users and companies see nothing', async () => {
    for (const u of [c, outsider, rival]) {
      expect((await db(u).list({ table: 'v_chat_messages', filters: [{ column: 'conversation_id', op: 'eq', value: dm }] })).count).toBe(0);
      await expect(db(u).rpc('chat_send_message', { p_conversation: dm, p_body: 'intrude' })).rejects.toThrow(/not a member/);
      await expect(db(u).rpc('chat_mark_read', { p_conversation: dm })).rejects.toThrow(/not a member/);
    }
    // direct table writes are blocked entirely
    await expect(db(a).insert('chat_messages', { company_id: company, conversation_id: dm, sender_id: a, body: 'bypass' })).rejects.toThrow();
  });

  it('edit/delete own messages only; reactions, pins and replies', async () => {
    const [mine] = await sql<{ id: string }>(pg, `select id from chat_messages where conversation_id = $1 and sender_id = $2 order by created_at limit 1`, [dm, a]);
    await expect(db(b).rpc('chat_edit_message', { p_message: mine.id, p_body: 'hacked' })).rejects.toThrow(/own messages/);
    await expect(db(b).rpc('chat_delete_message', { p_message: mine.id })).rejects.toThrow(/own messages/);
    await db(a).rpc('chat_edit_message', { p_message: mine.id, p_body: 'Hi Bob! 👋' });
    expect(await db(b).rpc<boolean>('chat_toggle_reaction', { p_message: mine.id, p_emoji: '👍' })).toBe(true);
    expect(await db(b).rpc<boolean>('chat_toggle_pin', { p_message: mine.id })).toBe(true);
    const reply = await db(b).rpc<{ id: string }>('chat_send_message', { p_conversation: dm, p_body: 'Sure!', p_reply_to: mine.id });
    const [row] = (await db(a).list<{ body: string; edited_at: string; reactions: { emoji: string; count: number }[]; pinned_at: string }>({ table: 'v_chat_messages', filters: [{ column: 'id', op: 'eq', value: mine.id }] })).rows;
    expect(row).toMatchObject({ body: 'Hi Bob! 👋', reactions: [{ emoji: '👍', count: 1 }] });
    expect(row.edited_at && row.pinned_at).toBeTruthy();
    const [r] = (await db(a).list<{ reply_to: { id: string } }>({ table: 'v_chat_messages', filters: [{ column: 'id', op: 'eq', value: reply.id }] })).rows;
    expect(r.reply_to.id).toBe(mine.id);
    await db(a).rpc('chat_delete_message', { p_message: mine.id });
    const [del] = await sql<{ body: string; deleted_at: string | null }>(pg, `select body, deleted_at from chat_messages where id = $1`, [mine.id]);
    expect(del.body).toBe('');
    expect(del.deleted_at).not.toBeNull();
  });
});

describe('Group chat', () => {
  it('creates groups with admin rules and membership events', async () => {
    group = await db(a).rpc<string>('chat_create_group', { p_company: company, p_name: 'People Team', p_description: 'HR updates', p_members: [b] });
    await expect(db(b).rpc('chat_add_members', { p_conversation: group, p_members: [c] })).rejects.toThrow(/Only group admins/);
    expect(await db(a).rpc<number>('chat_add_members', { p_conversation: group, p_members: [c] })).toBe(1);
    await expect(db(a).rpc('chat_add_members', { p_conversation: group, p_members: [rival] })).rejects.toThrow(/belong to this company/);
    await db(c).rpc('chat_send_message', { p_conversation: group, p_body: 'Hello team' });
    expect((await db(b).list({ table: 'v_chat_messages', filters: [{ column: 'conversation_id', op: 'eq', value: group }] })).count).toBe(3);
    expect((await db(outsider).list({ table: 'v_chat_messages', filters: [{ column: 'conversation_id', op: 'eq', value: group }] })).count).toBe(0);
    await expect(db(b).rpc('chat_remove_member', { p_conversation: group, p_user: c })).rejects.toThrow(/Only group admins/);
    await db(c).rpc('chat_remove_member', { p_conversation: group, p_user: c }); // leave
    expect((await db(c).list({ table: 'v_chat_messages', filters: [{ column: 'conversation_id', op: 'eq', value: group }] })).count).toBe(0);
  });

  it('promotes a new admin when the last admin leaves', async () => {
    await db(a).rpc('chat_remove_member', { p_conversation: group, p_user: a });
    const [p] = await sql<{ role: string }>(pg, `select role from chat_participants where conversation_id = $1 and user_id = $2`, [group, b]);
    expect(p.role).toBe('admin');
  });

  it('mute flag is per user', async () => {
    await db(b).rpc('chat_set_muted', { p_conversation: group, p_muted: true });
    const list = await db(b).rpc<{ id: string; muted: boolean }[]>('chat_my_conversations', { p_company: company });
    expect(list.find((x) => x.id === group)?.muted).toBe(true);
  });
});

describe('Attachments', () => {
  it('participants upload and attach; non-participants cannot upload or read', async () => {
    const path = `${company}/${dm}/${crypto.randomUUID()}/spec.pdf`;
    await uploadAs(pg, b, 'chat-attachments', path);
    await expect(uploadAs(pg, c, 'chat-attachments', `${company}/${dm}/${crypto.randomUUID()}/x.pdf`)).rejects.toThrow();
    await db(b).rpc('chat_send_message', { p_conversation: dm, p_body: 'See attached', p_attachments: [{ path, name: 'spec.pdf', mime: 'application/pdf', size: 4 }] });
    expect((await db(a).list({ table: 'v_chat_attachments', filters: [{ column: 'conversation_id', op: 'eq', value: dm }] })).count).toBe(1);
    expect((await db(c).list({ table: 'v_chat_attachments', filters: [{ column: 'conversation_id', op: 'eq', value: dm }] })).count).toBe(0);
    await expect(db(b).rpc('chat_send_message', { p_conversation: dm, p_body: 'x', p_attachments: [{ path: `${rivalCompany}/x/y.pdf`, name: 'y', size: 1 }] })).rejects.toThrow(/Invalid attachment/);
  });
});

describe('Presence & typing', () => {
  it('heartbeat presence is visible to colleagues only; typing visible to participants', async () => {
    await db(b).rpc('chat_heartbeat');
    expect((await db(a).list({ table: 'chat_user_presence', filters: [{ column: 'user_id', op: 'eq', value: b }] })).count).toBe(1);
    expect((await db(rival).list({ table: 'chat_user_presence', filters: [{ column: 'user_id', op: 'eq', value: b }] })).count).toBe(0);
    await db(b).rpc('chat_set_typing', { p_conversation: dm, p_typing: true });
    expect((await db(a).list({ table: 'chat_typing_status', filters: [{ column: 'conversation_id', op: 'eq', value: dm }] })).count).toBe(1);
    expect((await db(c).list({ table: 'chat_typing_status', filters: [{ column: 'conversation_id', op: 'eq', value: dm }] })).count).toBe(0);
  });
});

describe('Announcements', () => {
  it('only authorized users publish; members acknowledge; department targeting', async () => {
    await expect(db(b).insert('announcements', { company_id: company, title: 'Fake news', body: 'Not allowed to publish' })).rejects.toThrow();
    const ann = await db(a).insert<{ id: string }>('announcements', { company_id: company, title: 'Holiday on Friday', body: 'Office closed for Diwali.', requires_ack: true, pinned: true });
    const notes = await db(b).list({ table: 'notifications', filters: [{ column: 'type', op: 'eq', value: 'announcement' }] });
    expect(notes.count).toBe(1);
    await db(b).rpc('announcement_acknowledge', { p_announcement: ann.id });
    const [row] = (await db(a).list<{ ack_count: number }>({ table: 'v_announcements', filters: [{ column: 'id', op: 'eq', value: ann.id }] })).rows;
    expect(row.ack_count).toBe(1);
    expect((await db(rival).list({ table: 'v_announcements', filters: [{ column: 'company_id', op: 'eq', value: company }] })).count).toBe(0);
    // department-targeted announcement is hidden from employees outside the department
    const [dept] = await sql<{ id: string }>(pg, `select id from departments where company_id = $1 and name = 'Sales'`, [company]);
    await db(a).insert('announcements', { company_id: company, title: 'Sales kickoff', body: 'Sales team only meeting.', department_id: dept.id });
    expect((await db(b).list({ table: 'v_announcements', filters: [{ column: 'title', op: 'eq', value: 'Sales kickoff' }] })).count).toBe(0);
    expect((await db(a).list({ table: 'v_announcements', filters: [{ column: 'title', op: 'eq', value: 'Sales kickoff' }] })).count).toBe(1);
  });
});
