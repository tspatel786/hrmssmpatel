// @vitest-environment node
// Bulk candidate actions, interview reminders, offer templates, careers education + reference number (migration 1400).
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { anonUpload, clientFor, createTestDb, createUser, serviceClient, sql } from './harness';

let pg: PGlite;
let owner: string, recruiter: string, panelist: string, rival: string;
let company: string, rivalCompany: string, job: string;
const apps: string[] = [];
const db = (u: string | null) => clientFor(pg, u);
const roleId = async (c: string, name: string) => (await sql<{ id: string }>(pg, `select id from roles where company_id = $1 and name = $2`, [c, name]))[0].id;

async function apply(first: string, email: string, extra: Record<string, unknown> = {}) {
  const path = `${company}/incoming/${crypto.randomUUID()}/cv.pdf`;
  await anonUpload(pg, 'resumes', path);
  return db(null).rpc<{ application_id: string; reference_no: string }>('public_submit_application', {
    p_slug: 'rec-co', p_job: job, p_data: { first_name: first, email, phone: '9876543210', ...extra }, p_resume: { path, name: 'cv.pdf', size: 100 } });
}

beforeAll(async () => {
  pg = await createTestDb();
  owner = await createUser(pg, 'owner@rec.test', 'Rhea Owner');
  recruiter = await createUser(pg, 'recruiter@rec.test', 'Ravi Recruiter');
  panelist = await createUser(pg, 'panel@rec.test', 'Pam Panel');
  rival = await createUser(pg, 'rival@rec.test', 'Rob Rival');
  company = await db(owner).rpc<string>('create_company', { p_name: 'Rec Co', p_slug: 'rec-co' });
  rivalCompany = await db(rival).rpc<string>('create_company', { p_name: 'Rival Rec', p_slug: 'rival-rec' });
  await db(owner).rpc('invite_member', { p_company: company, p_email: 'recruiter@rec.test', p_role: await roleId(company, 'Recruiter') });
  await db(owner).rpc('invite_member', { p_company: company, p_email: 'panel@rec.test', p_role: await roleId(company, 'Employee') });
  await db(recruiter).rpc('accept_my_invitations');
  await db(panelist).rpc('accept_my_invitations');
  job = (await db(owner).insert<{ id: string }>('jobs', { company_id: company, title: 'Data Analyst', description: 'Analyse data and build dashboards.', status: 'published' })).id;
});

describe('Careers: education fields and reference number', () => {
  it('stores education, validates graduation year and returns a reference number', async () => {
    await expect(apply('Bad', 'bad@x.com', { graduation_year: '20x5' })).rejects.toThrow(/graduation year/);
    await expect(apply('Bad', 'bad2@x.com', { graduation_year: '1900' })).rejects.toThrow(/graduation year/);
    const r = await apply('Asha', 'asha@x.com', { highest_qualification: 'B.Tech Computer Science', institution: 'IIT Bombay', graduation_year: '2021' });
    expect(r.reference_no).toMatch(/^APP-[0-9A-F]{8}$/);
    expect(r.reference_no).toBe(`APP-${r.application_id.replace(/-/g, '').slice(0, 8).toUpperCase()}`);
    apps.push(r.application_id);
    const [cand] = (await db(owner).list<{ highest_qualification: string; institution: string; graduation_year: number }>({ table: 'v_candidates', filters: [{ column: 'email', op: 'eq', value: 'asha@x.com' }] })).rows;
    expect(cand).toMatchObject({ highest_qualification: 'B.Tech Computer Science', institution: 'IIT Bombay', graduation_year: 2021 });
    for (const [n, e] of [['Bilal', 'bilal@x.com'], ['Chen', 'chen@x.com'], ['Dana', 'dana@x.com']]) apps.push((await apply(n, e)).application_id);
  });
});

describe('Bulk candidate actions', () => {
  it('moves many applications at once with the same rules; reports per-item failures', async () => {
    const res = await db(recruiter).rpc<{ updated: number; failed: { id: string; error: string }[] }>('bulk_change_application_stage', { p_applications: apps.slice(0, 3), p_stage: 'shortlisted' });
    expect(res).toEqual({ updated: 3, failed: [] });
    const stages = await sql<{ stage: string }>(pg, `select stage from applications where id = any($1)`, [apps.slice(0, 3)]);
    expect(stages.every((s) => s.stage === 'shortlisted')).toBe(true);
    // history is recorded exactly like a single move
    expect((await sql(pg, `select 1 from application_stage_history where application_id = $1 and to_stage = 'shortlisted'`, [apps[0]])).length).toBe(1);
    // a hired application cannot move → reported, others still succeed
    await sql(pg, `update applications set stage = 'hired' where id = $1`, [apps[3]]);
    const mixed = await db(recruiter).rpc<{ updated: number; failed: { id: string; error: string }[] }>('bulk_change_application_stage', { p_applications: [apps[2], apps[3]], p_stage: 'screening' });
    expect(mixed.updated).toBe(1);
    expect(mixed.failed).toEqual([{ id: apps[3], error: 'Candidate has already been hired' }]);
  });

  it('bulk reject requires a reason; enforces permission and tenancy', async () => {
    await expect(db(recruiter).rpc('bulk_change_application_stage', { p_applications: apps.slice(0, 2), p_stage: 'rejected' })).rejects.toThrow(/rejection reason/);
    await expect(db(panelist).rpc('bulk_change_application_stage', { p_applications: apps.slice(0, 2), p_stage: 'screening' })).rejects.toThrow();
    await expect(db(rival).rpc('bulk_change_application_stage', { p_applications: apps.slice(0, 2), p_stage: 'screening' })).rejects.toThrow();
    const r = await db(recruiter).rpc<{ updated: number }>('bulk_change_application_stage', { p_applications: apps.slice(0, 2), p_stage: 'rejected', p_reason: 'Role filled internally' });
    expect(r.updated).toBe(2);
    await expect(db(recruiter).rpc('bulk_change_application_stage', { p_applications: Array.from({ length: 201 }, () => apps[0]), p_stage: 'screening' })).rejects.toThrow(/limited to 200/);
  });

  it('adds and removes tags on many candidates', async () => {
    const cands = (await sql<{ id: string }>(pg, `select id from candidates where company_id = $1`, [company])).map((c) => c.id);
    expect(await db(recruiter).rpc<number>('bulk_tag_candidates', { p_candidates: cands, p_tag: 'Campus 2026' })).toBe(cands.length);
    expect(await db(recruiter).rpc<number>('bulk_tag_candidates', { p_candidates: cands, p_tag: 'campus 2026' })).toBe(0); // idempotent, normalised
    expect((await sql<{ tags: string[] }>(pg, `select tags from candidates where id = $1`, [cands[0]]))[0].tags).toContain('campus 2026');
    expect(await db(recruiter).rpc<number>('bulk_tag_candidates', { p_candidates: cands, p_tag: 'campus 2026', p_remove: true })).toBe(cands.length);
    await expect(db(recruiter).rpc('bulk_tag_candidates', { p_candidates: cands, p_tag: '<script>' })).rejects.toThrow(/Tags must be/);
    await expect(db(rival).rpc('bulk_tag_candidates', { p_candidates: cands, p_tag: 'x' })).rejects.toThrow();
  });
});

describe('Interview reminders', () => {
  let interview: string;
  it('queues one reminder per scheduled time for candidate and panel, and notifies the panel', async () => {
    const soon = new Date(Date.now() + 5 * 3600_000).toISOString();
    interview = await db(owner).rpc<string>('schedule_interview', { p_application: apps[2], p_round: 'Technical', p_type: 'video', p_at: soon, p_duration: 60,
      p_location: null, p_meeting_link: 'https://meet.example.com/abc', p_panelists: [panelist] });
    expect(await serviceClient(pg).rpc<number>('send_interview_reminders')).toBe(1);
    const logs = await sql<{ to_email: string; status: string; subject: string }>(pg, `select to_email, status, subject from email_logs where template_key = 'interview_reminder' order by to_email`);
    expect(logs.map((l) => l.to_email)).toEqual(['chen@x.com', 'panel@rec.test']);
    expect(logs.every((l) => l.status === 'queued' && /Reminder: Technical interview/.test(l.subject))).toBe(true);
    expect((await db(panelist).list({ table: 'notifications', filters: [{ column: 'type', op: 'eq', value: 'interview' }, { column: 'title', op: 'eq', value: 'Interview tomorrow' }] })).count).toBe(1);
    // running again does nothing
    expect(await serviceClient(pg).rpc<number>('send_interview_reminders')).toBe(0);
  });

  it('rescheduling re-arms the reminder; cancelled / far-future interviews are skipped; users cannot trigger it', async () => {
    await db(owner).rpc('reschedule_interview', { p_interview: interview, p_at: new Date(Date.now() + 6 * 3600_000).toISOString(), p_duration: 60, p_location: null, p_meeting_link: null, p_panelists: [panelist] });
    expect(await serviceClient(pg).rpc<number>('send_interview_reminders')).toBe(1);
    expect((await sql(pg, `select 1 from email_logs where template_key = 'interview_reminder'`)).length).toBe(4);
    await db(owner).rpc('cancel_interview', { p_interview: interview, p_reason: 'Candidate unavailable' });
    await sql(pg, `update interviews set reminder_sent_at = null where id = $1`, [interview]);
    expect(await serviceClient(pg).rpc<number>('send_interview_reminders')).toBe(0);
    await expect(db(owner).rpc('send_interview_reminders')).rejects.toThrow();
  });

  it('new companies get the reminder template automatically', async () => {
    expect((await sql(pg, `select 1 from email_templates where company_id = $1 and key = 'interview_reminder'`, [rivalCompany])).length).toBe(1);
  });
});

describe('Offer templates', () => {
  it('every company starts with a default and an internship template; only one default', async () => {
    const t = (await db(owner).list<{ id: string; name: string; is_default: boolean }>({ table: 'offer_templates', filters: [{ column: 'company_id', op: 'eq', value: company }], order: [{ column: 'name' }] })).rows;
    expect(t.map((x) => [x.name, x.is_default])).toEqual([['Internship', false], ['Standard full-time', true]]);
    await db(owner).update('offer_templates', t[0].id, { is_default: true });
    const after = await sql<{ name: string }>(pg, `select name from offer_templates where company_id = $1 and is_default`, [company]);
    expect(after.map((x) => x.name)).toEqual(['Internship']);
  });

  it('offer managers create templates; others cannot; offers link to a same-company template only', async () => {
    const tpl = await db(owner).insert<{ id: string }>('offer_templates', { company_id: company, name: 'Contract', title: 'Contract Engagement',
      intro: 'We are pleased to engage you as {{role}} on a fixed-term contract.', general_terms: 'This contract runs for the agreed term and may be renewed.', closing: 'Please accept by {{expiry_date}}.' });
    await expect(db(panelist).insert('offer_templates', { company_id: company, name: 'Nope', intro: 'xxxxxxxxxxxx', general_terms: 'xxxxxxxxxxxx', closing: 'xxxxxxxxxxxx' })).rejects.toThrow();
    expect((await db(rival).list({ table: 'offer_templates', filters: [{ column: 'company_id', op: 'eq', value: company }] })).count).toBe(0);
    const [app] = await sql<{ id: string; candidate_id: string }>(pg, `select id, candidate_id from applications where id = $1`, [apps[2]]);
    await db(owner).rpc('change_application_stage', { p_application: app.id, p_stage: 'selected' });
    const base = { company_id: company, application_id: app.id, candidate_id: app.candidate_id, job_id: job, ctc_annual: 600000, basic_monthly: 25000, hra_monthly: 10000, allowances_monthly: 15000,
      joining_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), expiry_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) };
    const rivalTpl = (await sql<{ id: string }>(pg, `select id from offer_templates where company_id = $1 limit 1`, [rivalCompany]))[0].id;
    await expect(db(owner).insert('offers', { ...base, template_id: rivalTpl })).rejects.toThrow(/does not belong/);
    const offer = await db(owner).insert<{ id: string }>('offers', { ...base, template_id: tpl.id });
    const [v] = (await db(owner).list<{ template_id: string }>({ table: 'v_offers', filters: [{ column: 'id', op: 'eq', value: offer.id }] })).rows;
    expect(v.template_id).toBe(tpl.id);
  });
});
