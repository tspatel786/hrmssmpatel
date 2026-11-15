// @vitest-environment node
// LIVE acceptance test for migration 1500 (role dashboards, team view, HR employee invites, Hiring Manager approvals).
// Opt-in: SUPABASE_LIVE=1 npx vitest run tests/supabase/roles_1500.test.ts
// Uses admin-created, pre-confirmed users. Every invite targets an EXISTING account, so no invitation email is queued.
// Everything created is deleted afterwards.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@/lib/backend/supabase';

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
const run = Date.now().toString(36);
const PASSWORD = `Live-${run}-Pw1`;
const admin = live ? createClient(URL_, SERVICE, { auth: { persistSession: false }, realtime: { transport: WebSocket as never } }) : (null as unknown as SupabaseClient);
const userIds: string[] = [];
let company = '';

async function userClient(email: string, name: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  userIds.push(data.user.id);
  const sb = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket as never } });
  const { error: e2 } = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  if (e2) throw e2;
  return { id: data.user.id, email, db: createDb(sb) };
}

describe.skipIf(!live)('Supabase live: migration 1500', () => {
  let owner: Awaited<ReturnType<typeof userClient>>, hr: typeof owner, rec: typeof owner, mgr: typeof owner, emp: typeof owner;
  const role = async (name: string) =>
    (await owner.db.list<{ id: string }>({ table: 'roles', filters: [{ column: 'company_id', op: 'eq', value: company }, { column: 'name', op: 'eq', value: name }] })).rows[0].id;

  beforeAll(async () => {
    owner = await userClient(`owner.${run}@example.com`, 'Live Owner');
    hr = await userClient(`hr.${run}@example.com`, 'Live HR');
    rec = await userClient(`rec.${run}@example.com`, 'Live Recruiter');
    mgr = await userClient(`mgr.${run}@example.com`, 'Live Manager');
    emp = await userClient(`emp.${run}@example.com`, 'Live Employee');
    company = await owner.db.rpc<string>('create_company', { p_name: `Live 1500 ${run}`, p_slug: `live-1500-${run}` });
  }, 120_000);

  afterAll(async () => {
    if (!live) return;
    if (company) await admin.from('companies').delete().eq('id', company);
    for (const u of userIds) await admin.auth.admin.deleteUser(u);
  }, 120_000);

  it('a new company\'s Hiring Manager role holds requisitions.approve (role trigger)', async () => {
    const { data } = await admin.from('role_permissions').select('permission').eq('role_id', await role('Hiring Manager'));
    expect((data ?? []).map((r) => r.permission)).toContain('requisitions.approve');
  });

  it('existing companies\' Hiring Manager roles were granted requisitions.approve', async () => {
    const { data: roles } = await admin.from('roles').select('id').eq('name', 'Hiring Manager').eq('is_system', true);
    const ids = (roles ?? []).map((r) => r.id);
    const { data: granted } = await admin.from('role_permissions').select('role_id').eq('permission', 'requisitions.approve').in('role_id', ids);
    expect(new Set((granted ?? []).map((g) => g.role_id)).size).toBe(ids.length);
  });

  it('HR may give an employee record HRMS access with the Employee role only', async () => {
    await owner.db.rpc('invite_member', { p_company: company, p_email: hr.email, p_role: await role('HR Manager') });
    const empRec = await hr.db.insert<{ id: string }>('employees', {
      company_id: company, first_name: 'Live', last_name: 'Employee', email: emp.email, joining_date: '2025-01-06',
    });
    await expect(hr.db.rpc('invite_member', { p_company: company, p_email: rec.email, p_role: await role('Recruiter') })).rejects.toThrow();
    const res = await hr.db.rpc<{ status: string }>('invite_member', { p_company: company, p_email: emp.email, p_role: await role('Employee'), p_employee: empRec.id });
    expect(res.status).toBe('added');
  });

  it('dashboard_stats hides payroll and people metrics from a recruiter', async () => {
    await owner.db.rpc('invite_member', { p_company: company, p_email: rec.email, p_role: await role('Recruiter') });
    const s = await rec.db.rpc<{ sections: Record<string, boolean>; last_payroll: unknown; headcount: unknown; pipeline: unknown }>('dashboard_stats', { p_company: company });
    expect(s.sections).toMatchObject({ payroll: false, people: false, recruitment: true });
    expect(s.last_payroll).toBeNull();
    expect(s.headcount).toBeNull();
    expect(s.pipeline).not.toBeNull();
  });

  it('team_dashboard returns a manager\'s direct reports', async () => {
    const mgrRec = await owner.db.insert<{ id: string }>('employees', { company_id: company, first_name: 'Live', last_name: 'Manager', email: mgr.email, joining_date: '2025-01-06' });
    await owner.db.rpc('invite_member', { p_company: company, p_email: mgr.email, p_role: await role('Hiring Manager'), p_employee: mgrRec.id });
    const { data: e } = await admin.from('employees').select('id').eq('company_id', company).eq('email', emp.email).single();
    await owner.db.update('employees', e!.id, { manager_id: mgrRec.id });
    const t = await mgr.db.rpc<{ team_size: number; members: { id: string }[] }>('team_dashboard', { p_company: company });
    expect(t.team_size).toBe(1);
    expect(t.members.map((m) => m.id)).toEqual([e!.id]);
  });

  it('team_dashboard and dashboard_stats refuse outsiders', async () => {
    const outsider = await userClient(`out.${run}@example.com`, 'Live Outsider');
    await expect(outsider.db.rpc('team_dashboard', { p_company: company })).rejects.toThrow();
    await expect(outsider.db.rpc('dashboard_stats', { p_company: company })).rejects.toThrow();
  });
});
