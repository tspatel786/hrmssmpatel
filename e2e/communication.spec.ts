// Communication E2E against the REAL Supabase project (Realtime, RLS, Storage).
// Runs only in the "supabase" Playwright project:  SUPABASE_LIVE=1 npx playwright test --project=supabase
// Users are created with the admin API (pre-confirmed, no emails) and deleted afterwards.
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const URL_ = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY;
const SERVICE = fs.readFileSync(path.join(root, 'supabase/.temp/service-role-key'), 'utf8').trim();
const run = Date.now().toString(36);
const PW = `Chat-${run}-Pw1`;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false }, realtime: { transport: WebSocket as never } });
const created: { users: string[]; companies: string[] } = { users: [], companies: [] };

async function mkUser(email: string, name: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  created.users.push(data.user.id);
  const sb = createClient(URL_, ANON, { auth: { persistSession: false }, realtime: { transport: WebSocket as never } });
  await sb.auth.signInWithPassword({ email, password: PW });
  return { id: data.user.id, email, sb };
}

async function uiLogin(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
  await page.mouse.click(5, 5); // user gesture → unlocks Web Audio
}
const chimes = (page: Page) => page.evaluate(() => (window as unknown as { __hrmsChimeCount?: number }).__hrmsChimeCount ?? 0);

test.describe.configure({ mode: 'serial' });
let A: Awaited<ReturnType<typeof mkUser>>, B: Awaited<ReturnType<typeof mkUser>>, C: Awaited<ReturnType<typeof mkUser>>;
let company = '';

test.beforeAll(async () => {
  A = await mkUser(`anna.${run}@example.com`, 'Anna Admin');
  B = await mkUser(`ben.${run}@example.com`, 'Ben Builder');
  C = await mkUser(`cy.${run}@example.com`, 'Cy Outsider');
  const { data: co, error } = await A.sb.rpc('create_company', { p_name: 'Chat E2E Co', p_slug: `chat-e2e-${run}` });
  if (error) throw error;
  company = co as string;
  created.companies.push(company);
  const { data: other } = await C.sb.rpc('create_company', { p_name: 'Other Co', p_slug: `other-e2e-${run}` });
  created.companies.push(other as string);
  const { data: role } = await A.sb.from('roles').select('id').eq('company_id', company).eq('name', 'Employee').single();
  await A.sb.rpc('invite_member', { p_company: company, p_email: B.email, p_role: role!.id });
});

test.afterAll(async () => {
  for (const c of created.companies) {
    const { data: folders } = await admin.storage.from('chat-attachments').list(c, { limit: 100 });
    for (const f of folders ?? []) {
      const { data: subs } = await admin.storage.from('chat-attachments').list(`${c}/${f.name}`, { limit: 100 });
      for (const s of subs ?? []) {
        const { data: files } = await admin.storage.from('chat-attachments').list(`${c}/${f.name}/${s.name}`, { limit: 100 });
        await admin.storage.from('chat-attachments').remove((files ?? []).map((x) => `${c}/${f.name}/${s.name}/${x.name}`));
      }
    }
    await admin.from('companies').delete().eq('id', c);
  }
  for (const u of created.users) await admin.auth.admin.deleteUser(u);
});

test('real-time direct & group messaging with sound, receipts, files, search, mute and isolation', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errors: string[] = [];
  for (const p of [a, b]) p.on('pageerror', (e) => errors.push(e.message));
  await uiLogin(a, A.email);
  await uiLogin(b, B.email);
  await b.goto('/app');
  await b.mouse.click(5, 5);

  // 1-4. A starts a DM with B and sends a message
  await a.getByRole('link', { name: /Communication/ }).click();
  await a.getByRole('button', { name: 'New message' }).first().click();
  await a.getByRole('dialog').getByRole('button', { name: /Ben Builder/ }).click();
  await a.getByLabel('Message', { exact: true }).fill('Hello Ben, welcome to the team!');
  await a.getByLabel('Message', { exact: true }).press('Enter');
  await expect(a.getByTestId('message-pane').getByText('Hello Ben, welcome to the team!')).toBeVisible();

  // 5-7. B receives it in real time (no reload): sidebar unread badge + notification sound
  await expect(b.getByLabel(/1 unread messages/)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => chimes(b), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

  // 8-9. B opens the conversation → A sees the read receipt
  await b.getByRole('link', { name: /Communication/ }).click();
  await b.getByTestId('conversation-list').getByRole('button', { name: /^Anna Admin/ }).click();
  await expect(b.getByTestId('message-pane').getByText('Hello Ben, welcome to the team!')).toBeVisible();
  await expect(a.getByTestId('receipt')).toHaveText(/Read/, { timeout: 20_000 });

  // reply arrives at A in real time
  await b.getByLabel('Message', { exact: true }).fill('Thanks Anna! 🎉');
  await b.getByLabel('Message', { exact: true }).press('Enter');
  await expect(a.getByTestId('message-pane').getByText('Thanks Anna! 🎉')).toBeVisible({ timeout: 20_000 });

  // 11. file attachment
  await a.getByTestId('chat-file-input').setInputFiles({ name: 'handbook.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
  await a.getByLabel('Message', { exact: true }).fill('Here is the handbook');
  await a.getByRole('button', { name: 'Send message' }).click();
  await expect(b.getByTestId('message-pane').getByText('handbook.pdf')).toBeVisible({ timeout: 20_000 });

  // 12. message search
  await b.getByRole('button', { name: 'Search messages' }).click();
  await b.getByLabel('Search in conversation').fill('welcome');
  await expect(b.locator('li', { hasText: 'Hello Ben, welcome to the team!' }).last()).toBeVisible();
  await b.getByRole('button', { name: 'Search messages' }).click();

  // 10. group chat
  await a.getByRole('button', { name: 'New group' }).click();
  await a.getByRole('dialog').getByLabel('Group name').fill('Launch Squad');
  await a.getByRole('dialog').getByRole('button', { name: /Ben Builder/ }).click();
  await a.getByRole('button', { name: /Create group/ }).click();
  await a.getByLabel('Message', { exact: true }).fill('Kickoff at 3pm');
  await a.getByLabel('Message', { exact: true }).press('Enter');
  await expect(b.getByRole('button', { name: /Launch Squad/ })).toBeVisible({ timeout: 20_000 });

  // 13. muted conversations do not play a sound
  await b.getByRole('button', { name: /Launch Squad/ }).click();
  await b.getByRole('button', { name: 'Notification settings' }).click();
  await b.getByRole('switch', { name: 'Mute conversation' }).click();
  await b.getByRole('button', { name: 'Done' }).click();
  await b.getByTestId('conversation-list').getByRole('button', { name: /^Anna Admin/ }).click(); // leave the muted group view
  const before = await chimes(b);
  await A.sb.rpc('chat_send_message', { p_conversation: (await A.sb.from('chat_conversations').select('id').eq('name', 'Launch Squad').single()).data!.id, p_body: 'muted ping' });
  await b.waitForTimeout(4000);
  expect(await chimes(b)).toBe(before);

  // 14. multi-tab: a second tab for B — one message → exactly one sound across tabs
  const b2 = await ctxB.newPage();
  await b2.goto('/app');
  await b2.mouse.click(5, 5);
  await b.getByRole('link', { name: /Dashboard/ }).click();
  await b.waitForTimeout(1500);
  const t1 = await chimes(b);
  const t2 = await chimes(b2);
  const { data: dm } = await A.sb.from('chat_conversations').select('id').eq('type', 'direct').single();
  await A.sb.rpc('chat_send_message', { p_conversation: dm!.id, p_body: 'one sound only please' });
  await expect.poll(async () => (await chimes(b)) + (await chimes(b2)) - t1 - t2, { timeout: 15_000 }).toBe(1);
  await b.waitForTimeout(3000);
  expect((await chimes(b)) + (await chimes(b2)) - t1 - t2).toBe(1);

  // 16. history persists after refresh
  await b.goto(`/app/communication?c=${dm!.id}`);
  await expect(b.getByTestId('message-pane').getByText('Hello Ben, welcome to the team!')).toBeVisible();
  await expect(b.getByTestId('message-pane').getByText('one sound only please')).toBeVisible();

  // 15. unauthorized access: outsider from another company sees nothing and cannot post
  const { data: leak } = await C.sb.from('v_chat_messages').select('id').eq('conversation_id', dm!.id);
  expect(leak).toEqual([]);
  const { error: postErr } = await C.sb.rpc('chat_send_message', { p_conversation: dm!.id, p_body: 'intrusion' });
  expect(postErr?.message).toMatch(/not a member/);
  const { data: files } = await C.sb.storage.from('chat-attachments').list(company);
  expect(files ?? []).toEqual([]);

  expect(errors, errors.join('\n')).toEqual([]);
  await ctxA.close();
  await ctxB.close();
});
