// @vitest-environment node
// End-to-end hiring lifecycle executed against the real migrations (PGlite),
// through the same LocalDb adapter the demo app uses, with RLS enforced.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { anonUpload, clientFor, createTestDb, createUser, serviceClient, sql, uploadAs, verifyJoiningDocuments } from './harness';

let pg: PGlite;
let hrId: string;
let interviewerId: string;
let companyId: string;
let jobId: string;
let applicationId: string;
let candidateId: string;
let interviewId: string;
let offerId: string;
let offerToken: string;
let onboardingId: string;
let employeeId: string;

const hr = () => clientFor(pg, hrId);
const anon = () => clientFor(pg, null);
const inMinutes = (m: number) => new Date(Date.now() + m * 60000).toISOString();
const isoDate = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  pg = await createTestDb();
  hrId = await createUser(pg, 'hr@acme.test', 'Hana HR');
  interviewerId = await createUser(pg, 'ivan@acme.test', 'Ivan Interviewer');
});

describe('Hiring lifecycle: careers application → employee', () => {
  it('1. creates a company with default roles, templates and settings', async () => {
    companyId = await hr().rpc<string>('create_company', { p_name: 'Acme Corp', p_slug: 'acme' });
    expect(companyId).toMatch(/[0-9a-f-]{36}/);
    const roles = await hr().list<{ name: string }>({ table: 'roles', filters: [{ column: 'company_id', op: 'eq', value: companyId }] });
    expect(roles.rows.map((r) => r.name)).toEqual(expect.arrayContaining(['Company Admin', 'HR Manager', 'Recruiter', 'Employee']));
    const tpl = await hr().list({ table: 'email_templates', filters: [{ column: 'company_id', op: 'eq', value: companyId }] });
    expect(tpl.rows.length).toBeGreaterThanOrEqual(15);
    const perms = await hr().rpc<string[]>('my_permissions', { p_company: companyId });
    expect(perms).toContain('offers.approve');
    const mine = await hr().rpc<{ id: string }[]>('my_companies');
    expect(mine.map((c) => c.id)).toContain(companyId);
  });

  it('2. adds an interviewer user to the company', async () => {
    const roles = await hr().list<{ id: string }>({
      table: 'roles', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'name', op: 'eq', value: 'Interviewer' }],
    });
    const res = await hr().rpc<{ status: string }>('invite_member', {
      p_company: companyId, p_email: 'ivan@acme.test', p_role: roles.rows[0].id, p_base_url: 'http://localhost:5173',
    });
    expect(res.status).toBe('added');
    const members = await hr().list({ table: 'v_members', filters: [{ column: 'company_id', op: 'eq', value: companyId }] });
    expect(members.count).toBe(2);
  });

  it('3. creates and publishes a job', async () => {
    const dept = await hr().list<{ id: string }>({
      table: 'departments', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'name', op: 'eq', value: 'Engineering' }],
    });
    const job = await hr().insert<{ id: string; status: string; published_at: string | null }>('jobs', {
      company_id: companyId, title: 'Frontend Engineer', department_id: dept.rows[0].id, location: 'Pune',
      description: 'Build delightful React interfaces for our HR platform.', skills: ['react', 'typescript'],
      salary_min: 1200000, salary_max: 1800000, show_salary: true, status: 'draft', hiring_manager_id: hrId,
    });
    expect(job.published_at).toBeNull();
    const published = await hr().update<{ status: string; published_at: string }>('jobs', job.id, { status: 'published' });
    expect(published.published_at).not.toBeNull();
    jobId = job.id;
  });

  it('4. public careers page lists the job anonymously', async () => {
    const company = await anon().rpc<{ name: string }>('public_company', { p_slug: 'acme' });
    expect(company.name).toBe('Acme Corp');
    const jobs = await anon().rpc<{ id: string; salary_min: number }[]>('public_jobs', { p_slug: 'acme' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].salary_min).toBe(1200000);
    const detail = await anon().rpc<{ title: string }>('public_job', { p_slug: 'acme', p_job: jobId });
    expect(detail.title).toBe('Frontend Engineer');
  });

  it('5. candidate submits an application with resume (no account)', async () => {
    const path = `${companyId}/incoming/${crypto.randomUUID()}/cv.pdf`;
    await anonUpload(pg, 'resumes', path);
    const res = await anon().rpc<{ application_id: string }>('public_submit_application', {
      p_slug: 'acme', p_job: jobId,
      p_data: { first_name: 'Priya', last_name: 'Sharma', email: 'Priya.Sharma@example.com', phone: '+91 98765 43210',
        experience_years: '4', skills: 'React, TypeScript', cover_letter: 'Excited to apply!' },
      p_resume: { path, name: 'cv.pdf', size: 1234, mime: 'application/pdf' },
    });
    applicationId = res.application_id;
    expect(applicationId).toBeTruthy();
  });

  it('5b. rejects duplicate applications and missing resumes', async () => {
    await expect(anon().rpc('public_submit_application', {
      p_slug: 'acme', p_job: jobId, p_data: { first_name: 'Priya', email: 'priya.sharma@example.com', phone: '+91 98765 43210' },
      p_resume: null,
    })).rejects.toThrow(/resume/i);
    const path = `${companyId}/incoming/${crypto.randomUUID()}/cv.pdf`;
    await anonUpload(pg, 'resumes', path);
    await expect(anon().rpc('public_submit_application', {
      p_slug: 'acme', p_job: jobId, p_data: { first_name: 'Priya', email: 'priya.sharma@example.com', phone: '+91 98765 43210' },
      p_resume: { path, name: 'cv.pdf', size: 10 },
    })).rejects.toThrow(/already applied/i);
  });

  it('6. application appears in HRMS with an "application received" email queued', async () => {
    const apps = await hr().list<{ id: string; candidate_id: string; candidate_name: string; stage: string; resume_document_id: string }>({
      table: 'v_applications', filters: [{ column: 'job_id', op: 'eq', value: jobId }],
    });
    expect(apps.rows).toHaveLength(1);
    expect(apps.rows[0].candidate_name).toBe('Priya Sharma');
    expect(apps.rows[0].stage).toBe('applied');
    expect(apps.rows[0].resume_document_id).toBeTruthy();
    candidateId = apps.rows[0].candidate_id;
    const emails = await hr().list<{ template_key: string; to_email: string; status: string; subject: string }>({
      table: 'email_logs', filters: [{ column: 'related_id', op: 'eq', value: applicationId }],
    });
    expect(emails.rows).toHaveLength(1);
    expect(emails.rows[0]).toMatchObject({ template_key: 'application_received', to_email: 'priya.sharma@example.com', status: 'queued' });
    expect(emails.rows[0].subject).toContain('Frontend Engineer');
    const notes = await hr().list({ table: 'notifications', filters: [{ column: 'user_id', op: 'eq', value: hrId }] });
    expect(notes.count).toBeGreaterThan(0);
  });

  it('7. shortlisting sends exactly one email even if the stage is revisited', async () => {
    await hr().rpc('change_application_stage', { p_application: applicationId, p_stage: 'shortlisted', p_note: 'Strong profile' });
    await hr().rpc('change_application_stage', { p_application: applicationId, p_stage: 'on_hold' });
    await hr().rpc('change_application_stage', { p_application: applicationId, p_stage: 'shortlisted' });
    const rows = await sql<{ n: number }>(pg,
      `select count(*)::int n from email_logs where related_id = $1 and template_key = 'candidate_shortlisted'`, [applicationId]);
    expect(rows[0].n).toBe(1);
    const hist = await hr().list<{ to_stage: string; note: string | null }>({
      table: 'application_stage_history', filters: [{ column: 'application_id', op: 'eq', value: applicationId }],
      order: [{ column: 'created_at' }],
    });
    expect(hist.rows.map((h) => h.to_stage)).toEqual(['applied', 'shortlisted', 'on_hold', 'shortlisted']);
    expect(hist.rows[1].note).toBe('Strong profile');
    await expect(hr().update('applications', applicationId, { stage: 'hired' })).rejects.toThrow(/pipeline actions/i);
    await expect(hr().rpc('change_application_stage', { p_application: applicationId, p_stage: 'hired' })).rejects.toThrow(/cannot be set manually/);
  });

  it('8. schedules an interview, notifies candidate and panel, and detects conflicts', async () => {
    interviewId = await hr().rpc<string>('schedule_interview', {
      p_application: applicationId, p_round: 'Technical Round', p_type: 'video', p_at: inMinutes(10), p_duration: 60,
      p_location: '', p_meeting_link: 'https://meet.example.com/abc', p_panelists: [interviewerId],
    });
    expect(interviewId).toBeTruthy();
    const app = await hr().get<{ stage: string }>('applications', applicationId);
    expect(app?.stage).toBe('interview');
    const emails = await sql<{ template_key: string; to_email: string }>(pg,
      `select template_key, to_email from email_logs where related_id = $1 order by template_key`, [interviewId]);
    expect(emails).toEqual([
      { template_key: 'interview_scheduled', to_email: 'priya.sharma@example.com' },
      { template_key: 'interviewer_assigned', to_email: 'ivan@acme.test' },
    ]);
    await expect(hr().rpc('schedule_interview', {
      p_application: applicationId, p_round: 'Clash', p_type: 'video', p_at: inMinutes(30), p_duration: 30,
      p_location: '', p_meeting_link: '', p_panelists: [interviewerId],
    })).rejects.toThrow(/conflict/i);
    // interviewer can see their interview (and only through panel membership)
    const iv = await clientFor(pg, interviewerId).list({ table: 'v_interviews', filters: [{ column: 'company_id', op: 'eq', value: companyId }] });
    expect(iv.count).toBe(1);
  });

  it('9. interviewer submits feedback', async () => {
    const ivan = clientFor(pg, interviewerId);
    await ivan.rpc('submit_interview_feedback', {
      p_interview: interviewId, p_overall: 5, p_technical: 5, p_communication: 4, p_culture: 4,
      p_recommendation: 'strong_hire', p_strengths: 'Excellent React skills', p_weaknesses: 'None noted', p_comments: 'Hire',
    });
    const fb = await hr().list<{ overall_rating: number; interviewer_name: string }>({
      table: 'v_feedback', filters: [{ column: 'interview_id', op: 'eq', value: interviewId }],
    });
    expect(fb.rows[0]).toMatchObject({ overall_rating: 5, interviewer_name: 'Ivan Interviewer' });
    const iv = await hr().get<{ status: string }>('interviews', interviewId);
    expect(iv?.status).toBe('completed');
  });

  it('10. selects the candidate', async () => {
    await hr().rpc('change_application_stage', { p_application: applicationId, p_stage: 'selected' });
    const rows = await sql(pg, `select 1 from email_logs where related_id = $1 and template_key = 'candidate_selected'`, [applicationId]);
    expect(rows).toHaveLength(1);
  });

  it('11. creates an offer, routes it through approval', async () => {
    const offer = await hr().insert<{ id: string; status: string; offer_number: string; candidate_id: string }>('offers', {
      company_id: companyId, application_id: applicationId, ctc_annual: 1500000, basic_monthly: 62500, hra_monthly: 25000,
      allowances_monthly: 37500, joining_date: isoDate(20), expiry_date: isoDate(7), work_location: 'Pune', status: 'accepted',
    });
    expect(offer.status).toBe('draft'); // status is forced by the server
    expect(offer.offer_number).toMatch(/^OFR-/);
    expect(offer.candidate_id).toBe(candidateId);
    offerId = offer.id;
    await expect(hr().update('offers', offerId, { status: 'sent' })).rejects.toThrow(/offer workflow/i);
    const status = await hr().rpc<string>('submit_offer_for_approval', { p_offer: offerId });
    expect(status).toBe('pending_approval');
    await hr().rpc('decide_offer', { p_offer: offerId, p_approve: true, p_comments: 'Within budget' });
    const o = await hr().get<{ status: string }>('offers', offerId);
    expect(o?.status).toBe('approved');
  });

  it('12. sends the offer email with PDF attachment and secure link', async () => {
    const pdfPath = `${companyId}/offers/${offerId}.pdf`;
    await uploadAs(pg, hrId, 'documents', pdfPath);
    await expect(hr().rpc('send_offer', { p_offer: offerId, p_base_url: 'http://localhost:5173', p_pdf_path: 'elsewhere/x.pdf' }))
      .rejects.toThrow(/PDF/);
    const res = await hr().rpc<{ offer_link: string }>('send_offer', {
      p_offer: offerId, p_base_url: 'http://localhost:5173', p_pdf_path: pdfPath,
    });
    expect(res.offer_link).toMatch(/^http:\/\/localhost:5173\/offer\/[0-9a-f]{64}$/);
    offerToken = res.offer_link.split('/').pop()!;
    const [email] = await sql<{ attachments: { path: string }[]; body_html: string; status: string }>(pg,
      `select attachments, body_html, status from email_logs where related_id = $1 and template_key = 'offer_letter'`, [offerId]);
    expect(email.status).toBe('queued');
    expect(email.attachments[0].path).toBe(pdfPath);
    expect(email.body_html).toContain(res.offer_link);
    const [stored] = await sql<{ token_hash: string }>(pg, `select token_hash from offers where id = $1`, [offerId]);
    expect(stored.token_hash).not.toBe(offerToken); // only the hash is stored
    const app = await hr().get<{ stage: string }>('applications', applicationId);
    expect(app?.stage).toBe('offered');
  });

  it('12b. email worker delivers queued emails (mock provider) without duplicates', async () => {
    const svc = serviceClient(pg);
    const batch = await svc.rpc<{ id: string }[]>('claim_email_batch', { p_limit: 100 });
    expect(batch.length).toBeGreaterThanOrEqual(6);
    for (const e of batch) await svc.rpc('complete_email', { p_id: e.id, p_success: true, p_provider: 'mock', p_message_id: `mock-${e.id}`, p_error: null });
    const again = await svc.rpc<unknown[]>('claim_email_batch', { p_limit: 100 });
    expect(again).toHaveLength(0);
    // authenticated users cannot drive the worker
    await expect(hr().rpc('claim_email_batch', { p_limit: 1 })).rejects.toThrow();
  });

  it('13. candidate views and accepts the offer through the secure link', async () => {
    const view = await anon().rpc<{ status: string; candidate_name: string; ctc_annual: number }>('public_get_offer', { p_token: offerToken });
    expect(view).toMatchObject({ status: 'sent', candidate_name: 'Priya Sharma', ctc_annual: 1500000 });
    await expect(anon().rpc('public_get_offer', { p_token: 'f'.repeat(64) })).rejects.toThrow(/invalid or expired/i);
    await expect(anon().rpc('public_respond_offer', { p_token: offerToken, p_accept: true, p_signature: 'Someone Else' }))
      .rejects.toThrow(/full name/i);
    const res = await anon().rpc<{ status: string }>('public_respond_offer', { p_token: offerToken, p_accept: true, p_signature: 'Priya Sharma' });
    expect(res.status).toBe('accepted');
    await expect(anon().rpc('public_respond_offer', { p_token: offerToken, p_accept: false, p_signature: '' }))
      .rejects.toThrow(/already been accepted/i);
    const onb = await hr().list<{ id: string; tasks_total: number; status: string }>({
      table: 'v_onboardings', filters: [{ column: 'offer_id', op: 'eq', value: offerId }],
    });
    expect(onb.rows).toHaveLength(1);
    expect(onb.rows[0].tasks_total).toBe(6);
    onboardingId = onb.rows[0].id;
  });

  it('14. completes onboarding (joining confirmation, checklist) and creates the employee', async () => {
    await expect(hr().rpc('complete_onboarding', { p_onboarding: onboardingId })).rejects.toThrow(/Confirm the joining date/);
    await hr().rpc('confirm_joining', { p_onboarding: onboardingId, p_joining_date: isoDate(20) });
    const tasks = await hr().list<{ id: string }>({ table: 'onboarding_tasks', filters: [{ column: 'onboarding_id', op: 'eq', value: onboardingId }] });
    for (const t of tasks.rows) await hr().update('onboarding_tasks', t.id, { is_completed: true });
    await expect(hr().rpc('complete_onboarding', { p_onboarding: onboardingId })).rejects.toThrow(/Verify the required documents first/);
    // HR rejects a blurry upload with a reason; the joiner is emailed and may upload again (the helper below re-submits it)
    const [ob] = await sql<{ documents_token: string; company_id: string }>(pg, 'select documents_token, company_id from onboardings where id = $1', [onboardingId]);
    const portal = await clientFor(pg, null).rpc<{ documents: { id: string; label: string; status: string }[] }>('public_onboarding_documents', { p_token: ob.documents_token });
    expect(portal.documents.map((d) => d.label)).toContain('PAN card');
    const pan = portal.documents.find((d) => d.label === 'PAN card')!;
    const blurry = `${ob.company_id}/onboarding/${onboardingId}/${crypto.randomUUID()}/pan.jpg`;
    await anonUpload(pg, 'documents', blurry);
    await expect(clientFor(pg, null).rpc('public_submit_onboarding_document', { p_token: crypto.randomUUID(), p_document: pan.id, p_file: { path: blurry } })).rejects.toThrow(/not valid/);
    await clientFor(pg, null).rpc('public_submit_onboarding_document', { p_token: ob.documents_token, p_document: pan.id, p_file: { path: blurry, name: 'pan.jpg', size: 4 } });
    await expect(hr().rpc('verify_onboarding_document', { p_document: pan.id, p_approve: false })).rejects.toThrow(/reason/);
    await hr().rpc('verify_onboarding_document', { p_document: pan.id, p_approve: false, p_note: 'Image is blurry' });
    const [rej] = await sql<{ body_html: string }>(pg, "select body_html from email_logs where template_key = 'document_rejected'");
    expect(rej.body_html).toContain('Image is blurry');
    await verifyJoiningDocuments(pg, hrId, onboardingId);
    employeeId = await hr().rpc<string>('complete_onboarding', { p_onboarding: onboardingId, p_base_url: 'http://localhost:5173' });
    expect(employeeId).toBeTruthy();
    const emails = await sql<{ template_key: string }>(pg,
      `select template_key from email_logs where template_key in ('joining_confirmation','employee_credentials','offer_accepted','documents_requested','documents_verified') order by 1`);
    expect(emails.map((e) => e.template_key)).toEqual(['documents_requested', 'documents_verified', 'employee_credentials', 'joining_confirmation', 'offer_accepted']);
  });

  it('15-16. employee appears in Employee Management with offer terms; candidate marked hired', async () => {
    const emp = await hr().list<{ full_name: string; employee_code: string; ctc_annual: number; status: string; department_name: string }>({
      table: 'v_employees', filters: [{ column: 'company_id', op: 'eq', value: companyId }],
    });
    expect(emp.rows).toHaveLength(1);
    expect(emp.rows[0]).toMatchObject({ full_name: 'Priya Sharma', employee_code: 'EMP-0001', ctc_annual: 1500000, status: 'probation', department_name: 'Engineering' });
    const app = await hr().get<{ stage: string }>('applications', applicationId);
    expect(app?.stage).toBe('hired');
    const balances = await hr().list({ table: 'leave_balances', filters: [{ column: 'employee_id', op: 'eq', value: employeeId }] });
    expect(balances.count).toBeGreaterThan(0);
    // job had 1 opening → auto-closed
    const job = await hr().get<{ status: string }>('jobs', jobId);
    expect(job?.status).toBe('closed');
    const audit = await hr().list({ table: 'v_audit_logs', filters: [{ column: 'company_id', op: 'eq', value: companyId }], range: [0, 9] });
    expect(audit.count).toBeGreaterThan(10);
    const stats = await hr().rpc<{ headcount: number; pipeline: { stage: string; count: number }[] }>('dashboard_stats', { p_company: companyId });
    expect(stats.headcount).toBe(1);
    expect(stats.pipeline.find((p) => p.stage === 'hired')?.count).toBe(1);
  });
});
