// Deployment-order safety: the new frontend must work against the CURRENT production schema (before migrations
// 1200–1400) because the runbook deploys the frontend first. Runs in the "supabase" Playwright project:
//   SUPABASE_LIVE=1 npx playwright test --project=supabase
// Users/companies are created with the admin API (pre-confirmed, no emails) and deleted afterwards.
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const SERVICE = fs.readFileSync(path.join(root, 'supabase/.temp/service-role-key'), 'utf8').trim();
const run = `cmp${Date.now().toString(36)}`;
const PW = `Cmp-${run}-Pw1`;
const admin = createClient(env.VITE_SUPABASE_URL, SERVICE, { auth: { persistSession: false }, realtime: { transport: WebSocket as never } });
let userId = '';
let company = '';
let candidateId = '';

test.beforeAll(async () => {
  const email = `owner.${run}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true, user_metadata: { full_name: 'Compat Owner' } });
  if (error) throw error;
  userId = data.user.id;
  const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false }, realtime: { transport: WebSocket as never } });
  await sb.auth.signInWithPassword({ email, password: PW });
  const { data: co, error: ce } = await sb.rpc('create_company', { p_name: 'Compat Co', p_slug: `compat-${run}` });
  if (ce) throw ce;
  company = co as string;
  const { data: job } = await sb.from('jobs').insert({ company_id: company, title: 'Compat Analyst', description: 'Checks backwards compatibility.', status: 'published' }).select('id').single();
  const { data: cand } = await sb.from('candidates').insert({ company_id: company, first_name: 'Cora', last_name: 'Compat', email: `cora.${run}@example.com`, source: 'direct' }).select('id').single();
  candidateId = cand!.id;
  const { data: app } = await sb.from('applications').insert({ company_id: company, job_id: job!.id, candidate_id: candidateId, source: 'direct' }).select('id').single();
  const { error: se } = await sb.rpc('change_application_stage', { p_application: app!.id, p_stage: 'selected' });
  if (se) throw se;
});

test.afterAll(async () => {
  if (company) await admin.from('companies').delete().eq('id', company);
  if (userId) await admin.auth.admin.deleteUser(userId);
});

test('new frontend on the pre-migration schema: HR policy settings save and offer drafting still work', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/login');
  await page.getByLabel('Work email').fill(`owner.${run}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });

  // Settings → HR & payroll policies → save (late_grace_minutes must not be sent before migration 1300)
  await page.goto('/app/settings');
  await page.getByRole('tab', { name: 'HR & payroll policies' }).click();
  const hasGrace = await page.getByLabel('Late / early grace (minutes)').count();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible({ timeout: 15_000 });
  console.log(`[compat] grace field visible: ${hasGrace > 0} (expected false before migration 1300)`);

  // Candidate → Create offer → Save draft (template_id must not be sent before migration 1400)
  await page.goto(`/app/recruitment/candidates/${candidateId}`);
  await page.getByRole('button', { name: 'Create offer' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/app\/offers\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByText('Offer drafted')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
