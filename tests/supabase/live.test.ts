// @vitest-environment node
// LIVE integration tests against a real Supabase project (PostgREST + Auth + Storage + RLS).
// Opt-in only:  SUPABASE_LIVE=1 npx vitest run tests/supabase
// Needs .env.local (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) and the service-role key in
// supabase/.temp/service-role-key (gitignored) or SUPABASE_SERVICE_ROLE_KEY. Uses admin-created,
// pre-confirmed users (no emails are sent) and removes all test data afterwards.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createStorage } from '@/lib/backend/supabase';

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
const companies: string[] = [];

async function userClient(email: string, name: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  userIds.push(data.user.id);
  const sb = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket as never } });
  const { error: e2 } = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  if (e2) throw e2;
  return { id: data.user.id, sb, db: createDb(sb), storage: createStorage(sb) };
}
const pdf = () => new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' });
const isoDate = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

describe.skipIf(!live)('Supabase live: lifecycle, isolation, storage', () => {
  let hr: Awaited<ReturnType<typeof userClient>>;
  let rival: Awaited<ReturnType<typeof userClient>>;
  let panel: Awaited<ReturnType<typeof userClient>>;
  const anonSb = live ? createClient(URL_, ANON, { auth: { persistSession: false }, realtime: { transport: WebSocket as never } }) : (null as unknown as SupabaseClient);
  const anon = live ? createDb(anonSb) : (null as never);
  const anonStorage = live ? createStorage(anonSb) : (null as never);
  let company = '', rivalCompany = '', job = '', app = '', interview = '', offer = '', token = '', onboarding = '', resumePath = '';
  const slug = `live-${run}`;

  beforeAll(async () => {
    hr = await userClient(`hr.${run}@example.com`, 'Live HR');
    rival = await userClient(`rival.${run}@example.com`, 'Live Rival');
    panel = await userClient(`panel.${run}@example.com`, 'Live Panel');
  }, 120_000);

  afterAll(async () => {
    if (!live) return;
    for (const c of companies) {
      for (const bucket of ['resumes', 'documents']) {
        const { data: folders } = await admin.storage.from(bucket).list(c, { limit: 100 });
        for (const f of folders ?? []) {
          const { data: files } = await admin.storage.from(bucket).list(`${c}/${f.name}`, { limit: 1000 });
          for (const g of files ?? []) {
            const { data: inner } = await admin.storage.from(bucket).list(`${c}/${f.name}/${g.name}`, { limit: 1000 });
            const paths = (inner?.length ? inner.map((i) => `${c}/${f.name}/${g.name}/${i.name}`) : [`${c}/${f.name}/${g.name}`]);
            await admin.storage.from(bucket).remove(paths);
          }
        }
      }
      await admin.from('companies').delete().eq('id', c);
    }
    for (const u of userIds) await admin.auth.admin.deleteUser(u);
  }, 180_000);

  it('creates tenants and a published job', async () => {
    company = await hr.db.rpc<string>('create_company', { p_name: 'Live Corp', p_slug: slug });
    rivalCompany = await rival.db.rpc<string>('create_company', { p_name: 'Rival Corp', p_slug: `rival-${run}` });
    companies.push(company, rivalCompany);
    const roles = await hr.db.list<{ id: string }>({ table: 'roles', filters: [{ column: 'company_id', op: 'eq', value: company }, { column: 'name', op: 'eq', value: 'Interviewer' }] });
    expect((await hr.db.rpc<{ status: string }>('invite_member', { p_company: company, p_email: `panel.${run}@example.com`, p_role: roles.rows[0].id })).status).toBe('added');
    job = (await hr.db.insert<{ id: string }>('jobs', { company_id: company, title: 'Live Engineer', description: 'Live integration test job description.', status: 'published' })).id;
    const pub = await anon.rpc<{ id: string }[]>('public_jobs', { p_slug: slug });
    expect(pub.map((j) => j.id)).toEqual([job]);
  });

  it('anonymous candidate uploads a resume through storage RLS and applies', async () => {
    resumePath = `${company}/incoming/${crypto.randomUUID()}/cv.pdf`;
    await anonStorage.upload('resumes', resumePath, pdf(), 'application/pdf');
    await expect(anonStorage.download('resumes', resumePath)).rejects.toThrow(); // anon cannot read back
    const res = await anon.rpc<{ application_id: string }>('public_submit_application', {
      p_slug: slug, p_job: job, p_data: { first_name: 'Lena', last_name: 'Live', email: `lena.${run}@example.com`, phone: '+91 90000 00000' },
      p_resume: { path: resumePath, name: 'cv.pdf', size: 15, mime: 'application/pdf' },
    });
    app = res.application_id;
    expect(app).toBeTruthy();
  });

  it('enforces tenant isolation on tables, RPCs and storage', async () => {
    expect((await rival.db.list({ table: 'v_applications', filters: [{ column: 'company_id', op: 'eq', value: company }] })).count).toBe(0);
    expect((await rival.db.list({ table: 'email_logs', filters: [{ column: 'company_id', op: 'eq', value: company }] })).count).toBe(0);
    await expect(rival.db.update('jobs', job, { title: 'hijack' })).rejects.toThrow();
    await expect(rival.db.rpc('change_application_stage', { p_application: app, p_stage: 'rejected', p_reason: 'nope' })).rejects.toThrow(/Permission denied/);
    await expect(rival.storage.download('resumes', resumePath)).rejects.toThrow();
    await expect(anon.list({ table: 'candidates' })).rejects.toThrow();
    expect(await hr.storage.signedUrl('resumes', resumePath)).toMatch(/^https:\/\//);
  });

  it('runs the pipeline: shortlist → interview → feedback → select', async () => {
    await hr.db.rpc('change_application_stage', { p_application: app, p_stage: 'shortlisted' });
    interview = await hr.db.rpc<string>('schedule_interview', {
      p_application: app, p_round: 'Live Round', p_type: 'video', p_at: new Date(Date.now() + 5 * 60000).toISOString(), p_duration: 30,
      p_location: '', p_meeting_link: 'https://meet.example.com/live', p_panelists: [panel.id],
    });
    expect((await panel.db.list({ table: 'v_interviews', filters: [{ column: 'id', op: 'eq', value: interview }] })).count).toBe(1);
    await panel.db.rpc('submit_interview_feedback', { p_interview: interview, p_overall: 5, p_technical: 5, p_communication: 5, p_culture: 5, p_recommendation: 'strong_hire', p_strengths: 'Great', p_weaknesses: null, p_comments: null });
    await hr.db.rpc('change_application_stage', { p_application: app, p_stage: 'selected' });
    const emails = await hr.db.list<{ template_key: string }>({ table: 'email_logs', filters: [{ column: 'company_id', op: 'eq', value: company }] });
    expect(emails.rows.map((e) => e.template_key)).toEqual(expect.arrayContaining(['application_received', 'candidate_shortlisted', 'interview_scheduled', 'interviewer_assigned', 'candidate_selected']));
  });

  it('offer: approve, upload PDF, send, accept via token (anonymous)', async () => {
    offer = (await hr.db.insert<{ id: string }>('offers', { company_id: company, application_id: app, ctc_annual: 1200000, basic_monthly: 40000, hra_monthly: 20000, allowances_monthly: 35000, joining_date: isoDate(20), expiry_date: isoDate(5) })).id;
    await hr.db.rpc('submit_offer_for_approval', { p_offer: offer });
    await hr.db.rpc('decide_offer', { p_offer: offer, p_approve: true });
    const pdfPath = `${company}/offers/${offer}.pdf`;
    await hr.storage.upload('documents', pdfPath, pdf(), 'application/pdf');
    await expect(rival.storage.upload('documents', `${company}/offers/evil.pdf`, pdf(), 'application/pdf')).rejects.toThrow();
    const { offer_link } = await hr.db.rpc<{ offer_link: string }>('send_offer', { p_offer: offer, p_base_url: 'http://localhost:5173', p_pdf_path: pdfPath });
    token = offer_link.split('/').pop()!;
    expect((await anon.rpc<{ status: string }>('public_get_offer', { p_token: token })).status).toBe('sent');
    expect((await anon.rpc<{ status: string }>('public_respond_offer', { p_token: token, p_accept: true, p_signature: 'Lena Live' })).status).toBe('accepted');
  });

  it('onboarding creates the employee record', async () => {
    const ob = await hr.db.list<{ id: string }>({ table: 'onboardings', filters: [{ column: 'offer_id', op: 'eq', value: offer }] });
    onboarding = ob.rows[0].id;
    await hr.db.rpc('confirm_joining', { p_onboarding: onboarding, p_joining_date: isoDate(20) });
    const emp = await hr.db.rpc<string>('complete_onboarding', { p_onboarding: onboarding, p_base_url: 'http://localhost:5173' });
    const row = await hr.db.get<{ employee_code: string; email: string }>('employees', emp);
    expect(row).toMatchObject({ employee_code: 'EMP-0001', email: `lena.${run}@example.com` });
    const stats = await hr.db.rpc<{ headcount: number }>('dashboard_stats', { p_company: company });
    expect(stats.headcount).toBe(1);
  });

  // Invoking the worker sends every queued email. With a real provider (EMAIL_MODE=resend) that would mail the
  // throwaway test addresses, so this runs only when the project is known to be in mock mode: LIVE_EMAIL_MODE=mock.
  it.skipIf(process.env.LIVE_EMAIL_MODE !== 'mock')('deployed edge function delivers the queue (mock mode) and logs results', async () => {
    const queued = await hr.db.list({ table: 'email_logs', filters: [{ column: 'company_id', op: 'eq', value: company }, { column: 'status', op: 'eq', value: 'queued' }] });
    expect(queued.count).toBeGreaterThan(5);
    for (let i = 0; i < 5; i++) {
      const { data, error } = await hr.sb.functions.invoke('process-emails', { body: {} });
      expect(error).toBeNull();
      if (!data.processed) break;
      expect(data.mode).toBe('mock');
    }
    const left = await hr.db.list({ table: 'email_logs', filters: [{ column: 'company_id', op: 'eq', value: company }, { column: 'status', op: 'in', value: ['queued', 'sending', 'failed'] }] });
    expect(left.count).toBe(0);
    const offerMail = await hr.db.list<{ status: string; provider: string; attachments: unknown[] }>({ table: 'email_logs', filters: [{ column: 'related_id', op: 'eq', value: offer }, { column: 'template_key', op: 'eq', value: 'offer_letter' }] });
    expect(offerMail.rows[0]).toMatchObject({ status: 'sent', provider: 'mock' });
    expect(offerMail.rows[0].attachments).toHaveLength(1);
    const anonCall = await anonSb.functions.invoke('process-emails', { body: {} });
    expect(anonCall.error).toBeNull(); // anon JWT may trigger delivery of already-queued mail only (harmless, idempotent)
  });

  it('email worker functions are not callable by end users', async () => {
    await expect(hr.db.rpc('claim_email_batch', { p_limit: 1 })).rejects.toThrow();
    await expect(anon.rpc('enqueue_email', { p_company: company, p_template: 'x', p_to_email: 'a@b.co', p_to_name: '', p_vars: {}, p_dedupe_key: 'x' })).rejects.toThrow();
  });
});
