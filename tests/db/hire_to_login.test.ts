// @vitest-environment node
// Migration 1900: requisition alerts, every notification emailed (without duplicating dedicated emails), internal openings
// with internal applications and referrals, Employee ID + one-time set-password link, sign-in by Employee ID, appointment letter.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, serviceClient, sql, uploadAs } from './harness';

let pg: PGlite;
const ids: Record<string, string> = {};
const as = (u: string | null) => clientFor(pg, u ? ids[u] : null);
const emails = (to: string, template: string) =>
  sql<{ subject: string; body_html: string; attachments: unknown[] }>(pg,
    'select subject, body_html, attachments from email_logs where to_email = $1 and template_key = $2 order by created_at', [to, template]);

describe('hire-to-login flow (migration 1900)', () => {
  beforeAll(async () => {
    pg = await createTestDb();
    await sql(pg, "update public.platform_settings set app_url = 'https://hrms.example.test/'");
    ids.owner = await createUser(pg, 'owner@flow.test', 'Olivia Owner');
    ids.company = await as('owner').rpc<string>('create_company', { p_name: 'Flow Co', p_slug: 'flow-co' });
    ids.mgr = await createUser(pg, 'mgr@flow.test', 'Manu Manager');
    const [hm] = await sql<{ id: string }>(pg, "select id from roles where company_id = $1 and name = 'Hiring Manager'", [ids.company]);
    await as('owner').rpc('invite_member', { p_company: ids.company, p_email: 'mgr@flow.test', p_role: hm.id });
    await as('mgr').rpc('accept_my_invitations');
  }, 120_000);

  it('requisitions: submitting alerts approvers, the decision alerts the requester — in-app and by email', async () => {
    const r = await as('owner').insert<{ id: string }>('job_requisitions', {
      company_id: ids.company, title: 'Field Engineer', headcount: 2, justification: 'New client site in Solapur', status: 'pending_approval',
    });
    const [n] = await sql<{ title: string }>(pg, "select title from notifications where user_id = $1 and type = 'approval'", [ids.mgr]);
    expect(n.title).toBe('Requisition awaiting approval');
    const mail = (await emails('mgr@flow.test', 'notification')).find((e) => e.subject === 'Requisition awaiting approval')!;
    expect(mail).toBeTruthy();
    expect(mail.body_html).toContain('https://hrms.example.test/app/recruitment/requisitions'); // absolute link, no double slash

    await as('mgr').update('job_requisitions', r.id, { status: 'approved', decision_note: 'Budget confirmed' });
    const decided = (await emails('owner@flow.test', 'notification')).find((e) => e.subject === 'Requisition approved: Field Engineer')!;
    expect(decided).toBeTruthy();
    expect(decided.body_html).toContain('Budget confirmed');
  });

  it('a person who already got a dedicated email for an operation does not get a second, generic one', async () => {
    await pg.exec(`begin;
      select public.enqueue_email('${ids.company}', 'leave_decision', 'mgr@flow.test', 'Manu', '{}'::jsonb, 'dedupe-test');
      insert into public.notifications (company_id, user_id, type, title, body, link) values ('${ids.company}', '${ids.mgr}', 'leave', 'Leave approved', 'x', '/app/leave');
      commit;`);
    const rows = await sql(pg, "select 1 from email_logs where to_email = 'mgr@flow.test' and (template_key = 'leave_decision' or subject = 'Leave approved')");
    expect(rows).toHaveLength(1);
  });

  it('Employee ID + set-password link: valid once, bound to the employee email, linked as Employee', async () => {
    ids.emp = (await as('owner').insert<{ id: string }>('employees', {
      company_id: ids.company, first_name: 'Sana', last_name: 'Staff', email: 'sana@flow.test', joining_date: '2026-11-02',
      basic_monthly: 30000, hra_monthly: 12000, allowances_monthly: 3000,
    })).id;
    await as('owner').rpc('send_employee_login', { p_employee: ids.emp });
    const [cred] = await emails('sana@flow.test', 'employee_credentials');
    expect(cred.subject).toContain('EMP-0001');
    const token = /\/activate\/([0-9a-f-]{36})/.exec(cred.body_html)![1];
    expect(await as(null).rpc('public_employee_activation', { p_token: token })).toMatchObject({ status: 'valid', employee_code: 'EMP-0001', email: 'sana@flow.test' });

    // only the edge function (service role) may consume tokens or resolve Employee IDs
    await expect(as(null).rpc('consume_employee_activation', { p_token: token, p_user: ids.owner })).rejects.toThrow();
    await expect(as('owner').rpc('login_emails_for_code', { p_code: 'EMP-0001' })).rejects.toThrow();
    // a different account cannot take over the employee record
    await expect(serviceClient(pg).rpc('consume_employee_activation', { p_token: token, p_user: ids.mgr })).rejects.toThrow(/does not match/);

    ids.sana = await createUser(pg, 'sana@flow.test', 'Sana Staff');
    expect(await serviceClient(pg).rpc<string>('consume_employee_activation', { p_token: token, p_user: ids.sana })).toBe(ids.company);
    await expect(serviceClient(pg).rpc('consume_employee_activation', { p_token: token, p_user: ids.sana })).rejects.toThrow(/not valid/);
    const [m] = await sql<{ role: string; employee_id: string }>(pg,
      'select r.name role, m.employee_id from company_members m join roles r on r.id = m.role_id where m.company_id = $1 and m.user_id = $2', [ids.company, ids.sana]);
    expect(m).toEqual({ role: 'Employee', employee_id: ids.emp });
    expect(await serviceClient(pg).rpc<string[]>('login_emails_for_code', { p_code: 'emp-0001' })).toEqual(['sana@flow.test']);
    await expect(as('owner').rpc('send_employee_login', { p_employee: ids.emp })).rejects.toThrow(/already has an HRMS login/);
  });

  it('expired set-password links are refused', async () => {
    const e = await as('owner').insert<{ id: string }>('employees', {
      company_id: ids.company, first_name: 'Late', last_name: 'Joiner', email: 'late@flow.test', joining_date: '2026-11-02',
    });
    await as('owner').rpc('send_employee_login', { p_employee: e.id });
    await sql(pg, "update employee_activations set expires_at = now() - interval '1 minute' where employee_id = $1", [e.id]);
    const [{ token: activation_token }] = await sql<{ token: string }>(pg, 'select token from employee_activations where employee_id = $1', [e.id]);
    expect((await as(null).rpc<{ status: string }>('public_employee_activation', { p_token: activation_token })).status).toBe('expired');
    const late = await createUser(pg, 'late@flow.test');
    await expect(serviceClient(pg).rpc('consume_employee_activation', { p_token: activation_token, p_user: late })).rejects.toThrow(/expired/);
  });

  it('internal openings: publishing alerts every member; employees apply internally and refer candidates', async () => {
    const job = await as('owner').insert<{ id: string }>('jobs', {
      company_id: ids.company, title: 'Support Lead', location: 'Mangalwedha', description: 'Lead the customer support desk for our clients.',
      status: 'published', hiring_manager_id: ids.mgr,
    });
    expect((await emails('sana@flow.test', 'notification')).map((e) => e.subject)).toContain('New internal opening: Support Lead');

    const open = await as('sana').rpc<{ id: string; applied: boolean }[]>('internal_openings', { p_company: ids.company });
    expect(open.map((j) => j.id)).toEqual([job.id]);
    expect(open[0].applied).toBe(false);
    const appId = await as('sana').rpc<string>('internal_apply', { p_job: job.id, p_note: 'I know the client systems well.' });
    const [app] = await sql<{ source: string; csource: string }>(pg,
      'select a.source, c.source csource from applications a join candidates c on c.id = a.candidate_id where a.id = $1', [appId]);
    expect(app).toEqual({ source: 'internal', csource: 'internal' });
    expect((await as('sana').rpc<{ applied: boolean }[]>('internal_openings', { p_company: ids.company }))[0].applied).toBe(true);
    await expect(as('sana').rpc('internal_apply', { p_job: job.id })).rejects.toThrow(/already applied/);

    const resume = `${ids.company}/referrals/${crypto.randomUUID()}/cv.pdf`;
    await uploadAs(pg, ids.sana, 'resumes', resume);
    const refId = await as('sana').rpc<string>('refer_candidate', {
      p_job: job.id, p_data: { first_name: 'Ravi', last_name: 'Friend', email: 'ravi@example.com', phone: '9000000001', note: 'Ex-colleague' },
      p_resume: { path: resume, name: 'cv.pdf', mime: 'application/pdf', size: 4 },
    });
    const [ref] = await sql<{ source: string; referred_by: string }>(pg, 'select source, referred_by from applications where id = $1', [refId]);
    expect(ref).toEqual({ source: 'referral', referred_by: ids.emp });
    expect(await sql(pg, "select 1 from candidate_documents where application_id = $1 and doc_type = 'resume'", [refId])).toHaveLength(1);
    expect((await emails('sana@flow.test', 'notification')).map((e) => e.subject)).toContain('Referral submitted: Ravi Friend');
    await expect(as('sana').rpc('refer_candidate', { p_job: job.id, p_data: { first_name: 'Olivia', email: 'owner@flow.test', phone: '9000000002' } }))
      .resolves.toBeTruthy(); // the owner has no employee record, so referring them is allowed …
    await expect(as('sana').rpc('refer_candidate', { p_job: job.id, p_data: { first_name: 'Sana', email: 'sana@flow.test', phone: '9000000003' } }))
      .rejects.toThrow(/already an employee/); // … but existing employees apply internally instead

    // outsiders see nothing
    const stranger = await createUser(pg, 'stranger@else.test');
    await expect(clientFor(pg, stranger).rpc('internal_openings', { p_company: ids.company })).rejects.toThrow(/Not a member/);
    await expect(clientFor(pg, stranger).rpc('internal_apply', { p_job: job.id })).rejects.toThrow(/no longer available/);
  });

  it('appointment letter: saved to the employee documents and emailed as an attachment', async () => {
    const path = `${ids.company}/employees/${ids.emp}/appointment-letter.pdf`;
    await uploadAs(pg, ids.owner, 'documents', path);
    await expect(as('sana').rpc('send_appointment_letter', { p_employee: ids.emp, p_path: path })).rejects.toThrow(/permission/i);
    await as('owner').rpc('send_appointment_letter', { p_employee: ids.emp, p_path: path, p_file_name: 'Appointment letter - EMP-0001.pdf' });
    const docs = await as('sana').list<{ doc_type: string; file_name: string }>({ table: 'employee_documents', filters: [{ column: 'employee_id', op: 'eq', value: ids.emp }] });
    expect(docs.rows).toEqual([expect.objectContaining({ doc_type: 'appointment_letter', file_name: 'Appointment letter - EMP-0001.pdf' })]);
    const [mail] = await emails('sana@flow.test', 'appointment_letter');
    expect(mail.attachments).toEqual([{ bucket: 'documents', path, filename: 'Appointment letter - EMP-0001.pdf' }]);
  });
});
