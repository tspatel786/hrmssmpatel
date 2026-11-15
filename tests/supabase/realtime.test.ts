// @vitest-environment node
// LIVE Supabase Realtime verification for the Communication module (opt-in: npm run test:live).
// Verifies, against the real Realtime server + RLS:
//   - message INSERTs reach conversation participants in real time
//   - users of another company receive NO message, reaction or typing payloads
//   - DELETE events (which Realtime does not filter by RLS) do not leak chat metadata to other tenants
// Uses admin-created, pre-confirmed users (no emails) and deletes everything afterwards.
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const env = Object.fromEntries(
  (fs.existsSync(path.join(root, '.env.local')) ? fs.readFileSync(path.join(root, '.env.local'), 'utf8') : '')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const URL_ = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
const keyFile = path.join(root, 'supabase/.temp/service-role-key');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
const live = process.env.SUPABASE_LIVE === '1' && !!URL_ && !!ANON && !!SERVICE;

const run = `rt${Date.now().toString(36)}`;
const PW = `Rt-${run}-Pw1`;
const admin = live ? createClient(URL_, SERVICE, { auth: { persistSession: false }, realtime: { transport: WebSocket as never } }) : (null as unknown as SupabaseClient);
const users: string[] = [];
const companies: string[] = [];
const channels: [SupabaseClient, RealtimeChannel][] = [];
// every table the app subscribes to, before and after migration 1200
const TABLES = ['chat_messages', 'chat_participants', 'chat_conversations', 'chat_reactions', 'chat_typing_status', 'announcements', 'company_realtime_signals'];

interface Evt { table: string; type: string; new: Record<string, unknown>; old: Record<string, unknown> }

async function mkUser(email: string, name: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  users.push(data.user.id);
  const sb = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket as never } });
  const { data: s, error: e2 } = await sb.auth.signInWithPassword({ email, password: PW });
  if (e2) throw e2;
  sb.realtime.setAuth(s.session!.access_token);
  return { id: data.user.id, email, sb };
}

/** Subscribes to every chat table exactly as the app does (no filter, one channel per table) and records what arrives. */
async function listen(sb: SupabaseClient): Promise<Evt[]> {
  const events: Evt[] = [];
  await Promise.all(TABLES.map((table) => new Promise<void>((resolve, reject) => {
    const ch = sb.channel(`uat-${table}-${Math.random().toString(36).slice(2)}`);
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, (p) =>
      events.push({ table, type: p.eventType, new: (p.new ?? {}) as Record<string, unknown>, old: (p.old ?? {}) as Record<string, unknown> }));
    const t = setTimeout(() => reject(new Error(`realtime subscribe timeout (${table})`)), 20_000);
    ch.subscribe((status) => { if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(); } });
    channels.push([sb, ch]);
  })));
  return events;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(200); }
  return fn();
}

describe.skipIf(!live)('Supabase live: chat realtime delivery & tenant isolation', () => {
  let A: Awaited<ReturnType<typeof mkUser>>, B: Awaited<ReturnType<typeof mkUser>>, R: Awaited<ReturnType<typeof mkUser>>;
  let company = '', dm = '', groupId = '', attPath = '';
  let evB: Evt[] = [], evR: Evt[] = [];

  beforeAll(async () => {
    A = await mkUser(`rta.${run}@example.com`, 'RT Anna');
    B = await mkUser(`rtb.${run}@example.com`, 'RT Ben');
    R = await mkUser(`rtr.${run}@example.com`, 'RT Rival');
    const { data: co, error } = await A.sb.rpc('create_company', { p_name: 'RT Co', p_slug: `rt-co-${run}` });
    if (error) throw error;
    company = co as string;
    companies.push(company);
    const { data: other, error: e2 } = await R.sb.rpc('create_company', { p_name: 'RT Rival Co', p_slug: `rt-rival-${run}` });
    if (e2) throw e2;
    companies.push(other as string);
    const { data: role } = await A.sb.from('roles').select('id').eq('company_id', company).eq('name', 'Employee').single();
    const { error: e3 } = await A.sb.rpc('invite_member', { p_company: company, p_email: B.email, p_role: role!.id });
    if (e3) throw e3;
    const { data: conv, error: e4 } = await A.sb.rpc('chat_start_direct', { p_company: company, p_user: B.id });
    if (e4) throw e4;
    dm = conv as string;
    evB = await listen(B.sb);
    evR = await listen(R.sb);
    await wait(1500);
  }, 120_000);

  afterAll(async () => {
    if (!live) return;
    for (const [sb, ch] of channels) await sb.removeChannel(ch);
    if (attPath) await admin.storage.from('chat-attachments').remove([attPath]);
    for (const c of companies) await admin.from('companies').delete().eq('id', c);
    for (const u of users) await admin.auth.admin.deleteUser(u);
  }, 120_000);

  it('delivers a new message to the other participant in real time', async () => {
    const t0 = Date.now();
    const { data: m, error } = await A.sb.rpc('chat_send_message', { p_conversation: dm, p_body: 'realtime hello', p_client_id: `rt-${run}-0001` });
    expect(error).toBeNull();
    expect(await until(() => evB.some((e) => e.table === 'chat_messages' && e.type === 'INSERT' && e.new.id === (m as { id: string }).id))).toBe(true);
    const got = evB.find((e) => e.table === 'chat_messages' && e.new.id === (m as { id: string }).id)!;
    expect(got.new.body).toBe('realtime hello');
    console.info(`[uat] realtime delivery latency ≈ ${Date.now() - t0} ms`);
  });

  it('typing, read receipts and reactions propagate to participants', async () => {
    const { data: msg } = await B.sb.rpc('chat_send_message', { p_conversation: dm, p_body: 'react to me' });
    await wait(1500);
    const seen = (from: number) => evB.slice(from).map((e) => `${e.table}:${e.type}`);
    // typing → B sees a typing row change
    let from = evB.length;
    await A.sb.rpc('chat_set_typing', { p_conversation: dm, p_typing: true });
    expect(await until(() => seen(from).includes('chat_typing_status:INSERT') || seen(from).includes('chat_typing_status:UPDATE')), seen(from).join()).toBe(true);
    // reaction → B is told (directly, or via the conversation row once the isolation migration is applied)
    from = evB.length;
    await A.sb.rpc('chat_toggle_reaction', { p_message: (msg as { id: string }).id, p_emoji: '👍' });
    expect(await until(() => seen(from).some((s) => s.startsWith('chat_reactions:') || s === 'chat_conversations:UPDATE')), seen(from).join()).toBe(true);
    // read receipt → B (the sender) is told A read it
    from = evB.length;
    await A.sb.rpc('chat_mark_read', { p_conversation: dm });
    expect(await until(() => seen(from).some((s) => s === 'chat_participants:UPDATE' || s === 'chat_conversations:UPDATE')), seen(from).join()).toBe(true);
  });

  it('another company cannot read, post to, act on or download anything from company A (tables, RPCs, storage)', async () => {
    const { data: group, error: ge } = await A.sb.rpc('chat_create_group', { p_company: company, p_name: 'RT Group', p_description: null, p_members: [B.id] });
    expect(ge).toBeNull();
    groupId = group as string;
    attPath = `${company}/${dm}/${crypto.randomUUID()}/secret.pdf`;
    const { error: ue } = await A.sb.storage.from('chat-attachments').upload(attPath, new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), { contentType: 'application/pdf' });
    expect(ue).toBeNull();
    const { data: sent, error: se } = await A.sb.rpc('chat_send_message', { p_conversation: dm, p_body: 'attachment for B only', p_attachments: [{ path: attPath, name: 'secret.pdf', mime: 'application/pdf', size: 14 }] });
    expect(se).toBeNull();
    const msgId = (sent as { id: string }).id;

    // tables & views: nothing of company A is visible
    for (const table of ['chat_conversations', 'chat_participants', 'chat_messages', 'chat_attachments', 'chat_reactions', 'chat_typing_status',
      'v_chat_messages', 'v_chat_attachments', 'chat_message_reads', 'v_chat_directory', 'announcements', 'v_announcements']) {
      const { data } = await R.sb.from(table).select('*').limit(50);
      const leak = JSON.stringify(data ?? []);
      expect(leak.includes(dm) || leak.includes(groupId) || leak.includes(company) || leak.includes(A.id), `${table} leaked company A data`).toBe(false);
    }
    expect((await R.sb.rpc('chat_my_conversations', { p_company: company })).data ?? []).toEqual([]);

    // RPCs: every write path is refused
    const refused = async (fn: string, args: Record<string, unknown>) => {
      const { error } = await R.sb.rpc(fn, args);
      expect(error, `${fn} should be refused`).not.toBeNull();
    };
    await refused('chat_send_message', { p_conversation: dm, p_body: 'intrusion' });
    await refused('chat_send_message', { p_conversation: groupId, p_body: 'intrusion' });
    await refused('chat_start_direct', { p_company: company, p_user: A.id });
    await refused('chat_add_members', { p_conversation: groupId, p_members: [R.id] });
    await refused('chat_mark_read', { p_conversation: dm });
    await refused('chat_set_typing', { p_conversation: dm, p_typing: true });
    await refused('chat_toggle_reaction', { p_message: msgId, p_emoji: '👀' });
    await refused('chat_toggle_pin', { p_message: msgId });
    await refused('chat_edit_message', { p_message: msgId, p_body: 'hacked' });
    await refused('chat_delete_message', { p_message: msgId });
    // and company A cannot pull an outsider into its group
    const { error: addErr } = await A.sb.rpc('chat_add_members', { p_conversation: groupId, p_members: [R.id] });
    expect(addErr?.message).toMatch(/belong to this company/);

    // storage: cannot list, download, sign or upload into company A's chat folders
    expect((await R.sb.storage.from('chat-attachments').list(company)).data ?? []).toEqual([]);
    expect((await R.sb.storage.from('chat-attachments').download(attPath)).error).not.toBeNull();
    expect((await R.sb.storage.from('chat-attachments').createSignedUrl(attPath, 60)).error).not.toBeNull();
    const { error: upErr } = await R.sb.storage.from('chat-attachments').upload(`${company}/${dm}/${crypto.randomUUID()}/x.pdf`, new Blob(['x'], { type: 'application/pdf' }));
    expect(upErr).not.toBeNull();
    // the participant can
    expect((await B.sb.storage.from('chat-attachments').download(attPath)).error).toBeNull();
  });

  it('another company receives no chat payloads at all, including DELETE events (requires migration 1200)', async () => {
    await A.sb.rpc('chat_set_typing', { p_conversation: dm, p_typing: true });
    await A.sb.rpc('chat_set_typing', { p_conversation: dm, p_typing: false });
    const { data: msgs } = await A.sb.from('chat_messages').select('id').eq('conversation_id', dm).not('sender_id', 'is', null).limit(1);
    await A.sb.rpc('chat_toggle_reaction', { p_message: msgs![0].id, p_emoji: '🎯' });
    await A.sb.rpc('chat_toggle_reaction', { p_message: msgs![0].id, p_emoji: '🎯' }); // reaction removal
    await A.sb.rpc('chat_remove_member', { p_conversation: groupId, p_user: B.id }); // participant removal
    const { data: ann, error: ae } = await A.sb.from('announcements').insert({ company_id: company, title: 'RT secret notice', body: 'Only company A should know.' }).select('id').single();
    expect(ae).toBeNull();
    await A.sb.from('announcements').delete().eq('id', ann!.id); // announcement deletion
    await A.sb.rpc('chat_send_message', { p_conversation: dm, p_body: 'secret for company A only' });
    await wait(7000);
    const ids = [dm, groupId, company, A.id, B.id, msgs![0].id, ann!.id];
    const leaked = evR.filter((e) => ids.some((id) => JSON.stringify([e.new, e.old]).includes(id)));
    if (leaked.length) console.warn('[uat] cross-tenant realtime events:', JSON.stringify(leaked.map((e) => ({ table: e.table, type: e.type, old: e.old }))));
    expect(leaked).toEqual([]);
  });
});
