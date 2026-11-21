// @vitest-environment node
// Migration 2000: leave rejection reason, resignation & exit, document management, daily jobs, overview dashboards, reports.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, serviceClient, sql, uploadAs } from './harness';

let pg: PGlite;
const ids: Record<string, string> = {};
const as = (u: string) => clientFor(pg, ids[u]);
const svc = () => serviceClient(pg);
let today = '';
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const notes = (user: string) => sql<{ title: string; body: string }>(pg, 'select title, body from notifications where user_id = $1 order by created_at', [ids[user]]);

/** Creates an employee record and its HRMS login (Employee ID + set-password link consumed by the service role). */
async function employee(key: string, first: string, extra: Record<string, unknown> = {}) {
  const email = `${key}@exit.test`;
  ids[`${key}Emp`] = (await as('hr').insert<{ id: string }>('employees', {
    company_id: ids.company, first_name: first, last_name: 'Test', email, joining_date: addDays(today, -400),
    basic_monthly: 30000, hra_monthly: 12000, allowances_monthly: 3000, ...extra,
  })).id;
  await as('hr').rpc('send_employee_login', { p_employee: ids[`${key}Emp`] });
  const [{ token }] = await sql<{ token: string }>(pg, 'select token from employee_activations where employee_id = $1', [ids[`${key}Emp`]]);
  ids[key] = await createUser(pg, email, `${first} Test`);
  await svc().rpc('consume_employee_activation', { p_token: token, p_user: ids[key] });
}

describe('exit, documents and daily jobs (migration 2000)', () => {
  beforeAll(async () => {
    pg = await createTestDb();
    ids.hr = await createUser(pg, 'hr@exit.test', 'Hema HR');
    ids.company = await as('hr').rpc<string>('create_company', { p_name: 'Exit Co', p_slug: 'exit-co' });
    [{ today }] = await sql<{ today: string }>(pg, 'select to_char((now() at time zone public.company_tz($1))::date, \'YYYY-MM-DD\') today', [ids.company]);
    await employee('mgr', 'Manav');
    await employee('emp', 'Esha', { manager_id: ids.mgrEmp, date_of_birth: '1995-' + addDays(today, 5).slice(5) });
    await employee('peer', 'Pavan', { manager_id: ids.mgrEmp });
    ids.other = await createUser(pg, 'owner@other.test');
    ids.otherCompany = await as('other').rpc<string>('create_company', { p_name: 'Other Co', p_slug: 'other-co' });
  }, 180_000);

  it('leave: a manager must give a reason to reject', async () => {
    const [lt] = await sql<{ id: string }>(pg, "select id from leave_types where company_id = $1 and code = 'CL'", [ids.company]);
    let start = addDays(today, 10);
    while ([0, 6].includes(new Date(`${start}T00:00:00Z`).getUTCDay())) start = addDays(start, 1);
    const req = await as('emp').rpc<string>('apply_leave', { p_company: ids.company, p_employee: ids.empEmp, p_type: lt.id, p_start: start, p_end: start, p_half_day: false, p_reason: 'Family function' });
    await expect(as('mgr').rpc('decide_leave', { p_request: req, p_approve: false })).rejects.toThrow(/reason/);
    await as('mgr').rpc('decide_leave', { p_request: req, p_approve: false, p_note: 'Release week, please move it' });
    const [r] = await sql<{ status: string; decision_note: string }>(pg, 'select status, decision_note from leave_requests where id = $1', [req]);
    expect(r).toEqual({ status: 'rejected', decision_note: 'Release week, please move it' });
  });

  it('resignation: employee -> manager -> HR, notice period, checklist, settlement, completion, deactivation', async () => {
    await expect(as('emp').rpc('submit_resignation', { p_company: ids.company, p_reason: 'short', p_last_day: addDays(today, 30) })).rejects.toThrow(/reason/);
    await expect(as('emp').rpc('submit_resignation', { p_company: ids.company, p_reason: 'Moving to Pune for family reasons', p_last_day: addDays(today, -1) })).rejects.toThrow(/past/);
    const id = await as('emp').rpc<string>('submit_resignation', { p_company: ids.company, p_reason: 'Moving to Pune for family reasons', p_last_day: addDays(today, 30) });
    ids.resignation = id;
    await expect(as('emp').rpc('submit_resignation', { p_company: ids.company, p_reason: 'Moving to Pune for family reasons', p_last_day: addDays(today, 30) })).rejects.toThrow(/already/);
    expect((await notes('mgr')).map((n) => n.title)).toContain('Resignation from Esha Test');
    // employee is NOT deactivated or put on notice just by resigning
    expect((await sql<{ status: string }>(pg, 'select status from employees where id = $1', [ids.empEmp]))[0].status).toBe('active');

    // visibility: employee, their manager and HR — never a colleague or another company
    expect((await as('emp').list({ table: 'resignations' })).rows).toHaveLength(1);
    expect((await as('mgr').list({ table: 'v_resignations' })).rows).toHaveLength(1);
    expect((await as('peer').list({ table: 'resignations' })).rows).toHaveLength(0);
    expect((await as('other').list({ table: 'resignations' })).rows).toHaveLength(0);
    await expect(as('emp').update('resignations', id, { status: 'approved' })).rejects.toThrow();

    // only the reporting manager decides the first step; HR cannot skip it
    await expect(as('peer').rpc('decide_resignation_manager', { p_resignation: id, p_approve: true })).rejects.toThrow(/reporting manager/);
    await expect(as('hr').rpc('decide_resignation_hr', { p_resignation: id, p_approve: true })).rejects.toThrow(/not waiting for HR/);
    await expect(as('mgr').rpc('decide_resignation_manager', { p_resignation: id, p_approve: false })).rejects.toThrow(/reason/);
    await as('mgr').rpc('decide_resignation_manager', { p_resignation: id, p_approve: true, p_comment: 'Thanks for everything' });
    expect((await notes('hr')).map((n) => n.title)).toContain('Resignation awaiting HR approval: Esha Test');

    await expect(as('mgr').rpc('decide_resignation_hr', { p_resignation: id, p_approve: true })).rejects.toThrow(/permission/i);
    await as('hr').rpc('decide_resignation_hr', { p_resignation: id, p_approve: true, p_comment: 'Approved', p_last_day: addDays(today, 20) });
    const [e] = await sql<{ status: string; exit_date: string }>(pg, "select status, to_char(exit_date, 'YYYY-MM-DD') exit_date from employees where id = $1", [ids.empEmp]);
    expect(e).toEqual({ status: 'notice', exit_date: addDays(today, 20) });
    const [v] = (await as('hr').list<{ days_left: number; tasks_total: number; manager_name: string }>({ table: 'v_resignations', filters: [{ column: 'id', op: 'eq', value: id }] })).rows;
    expect({ days_left: v.days_left, tasks_total: v.tasks_total, manager_name: v.manager_name }).toEqual({ days_left: 20, tasks_total: 6, manager_name: 'Manav Test' });
    // the employee still works and can sign in during the notice period
    expect((await as('emp').rpc<{ employee: { id: string } }>('my_dashboard', { p_company: ids.company })).employee.id).toBe(ids.empEmp);

    // completion needs the checklist and the settlement
    await expect(as('hr').rpc('complete_exit', { p_resignation: id })).rejects.toThrow(/exit checklist/);
    const tasks = await as('hr').list<{ id: string }>({ table: 'exit_tasks', filters: [{ column: 'resignation_id', op: 'eq', value: id }] });
    await expect(as('emp').update('exit_tasks', tasks.rows[0].id, { is_completed: true })).rejects.toThrow();
    for (const t of tasks.rows) await as('hr').update('exit_tasks', t.id, { is_completed: true });
    await expect(as('hr').rpc('complete_exit', { p_resignation: id })).rejects.toThrow(/settlement/);
    await as('hr').rpc('set_exit_settlement', { p_resignation: id, p_status: 'paid', p_amount: 54000, p_note: 'Full and final paid' });
    expect(await as('hr').rpc<string>('complete_exit', { p_resignation: id })).toBe('completed'); // last day still ahead: access stays

    // exit letters land in the employee documents and are emailed with the PDF
    const path = `${ids.company}/employees/${ids.empEmp}/relieving.pdf`;
    await uploadAs(pg, ids.hr, 'documents', path);
    await as('hr').rpc('send_exit_letter', { p_employee: ids.empEmp, p_path: path, p_kind: 'relieving_letter', p_file_name: 'Relieving letter.pdf' });
    const [mail] = await sql<{ attachments: unknown[] }>(pg, "select attachments from email_logs where template_key = 'exit_letter' and to_email = 'emp@exit.test'");
    expect(mail.attachments).toHaveLength(1);

    // the day after the last working day the daily job closes access
    await sql(pg, 'update resignations set approved_last_day = $2 where id = $1', [id, addDays(today, -1)]);
    await sql(pg, 'delete from daily_job_runs');
    await svc().rpc('run_daily_jobs');
    const [after] = await sql<{ status: string }>(pg, 'select status from employees where id = $1', [ids.empEmp]);
    expect(after.status).toBe('inactive');
    const [m] = await sql<{ status: string }>(pg, 'select status from company_members where company_id = $1 and user_id = $2', [ids.company, ids.emp]);
    expect(m.status).toBe('inactive');
    await expect(as('emp').rpc('my_dashboard', { p_company: ids.company })).rejects.toThrow();
    expect((await notes('hr')).map((n) => n.title)).toContain('Exit completed: Esha Test');
  });

  it('withdrawal: immediate while pending; after approval HR decides and the employee returns to active', async () => {
    const a = await as('peer').rpc<string>('submit_resignation', { p_company: ids.company, p_reason: 'Higher studies abroad next year', p_last_day: addDays(today, 30) });
    expect(await as('peer').rpc<string>('withdraw_resignation', { p_resignation: a, p_reason: 'Changed my mind' })).toBe('withdrawn');
    const b = await as('peer').rpc<string>('submit_resignation', { p_company: ids.company, p_reason: 'Higher studies abroad next year', p_last_day: addDays(today, 30) });
    await as('mgr').rpc('decide_resignation_manager', { p_resignation: b, p_approve: true });
    await as('hr').rpc('decide_resignation_hr', { p_resignation: b, p_approve: true });
    expect(await as('peer').rpc<string>('withdraw_resignation', { p_resignation: b, p_reason: 'Admission deferred' })).toBe('requested');
    await expect(as('hr').rpc('complete_exit', { p_resignation: b })).rejects.toThrow(/cancellation/);
    await as('hr').rpc('decide_resignation_withdrawal', { p_resignation: b, p_approve: true, p_comment: 'Welcome back' });
    const [e] = await sql<{ status: string; exit_date: string | null }>(pg, 'select status, exit_date from employees where id = $1', [ids.peerEmp]);
    expect(e).toEqual({ status: 'active', exit_date: null });
  });

  it('documents: employees upload their own (pending), HR verifies or rejects with a reason, history is kept', async () => {
    const path = `${ids.company}/employees/${ids.peerEmp}/self/${crypto.randomUUID()}/pan.pdf`;
    await uploadAs(pg, ids.peer, 'documents', path);
    // cannot write into someone else's folder, or mark their own upload verified
    await expect(uploadAs(pg, ids.peer, 'documents', `${ids.company}/employees/${ids.mgrEmp}/self/x/a.pdf`)).rejects.toThrow();
    await expect(as('peer').insert('employee_documents', { company_id: ids.company, employee_id: ids.peerEmp, doc_type: 'pan', file_name: 'pan.pdf', storage_path: path, status: 'verified' })).rejects.toThrow();
    const doc = await as('peer').insert<{ id: string }>('employee_documents', {
      company_id: ids.company, employee_id: ids.peerEmp, doc_type: 'pan', file_name: 'pan.pdf', storage_path: path, status: 'pending', expiry_date: addDays(today, 30),
    });
    expect((await notes('hr')).map((n) => n.title)).toContain('Document to verify: Pavan Test');
    await expect(as('peer').rpc('verify_employee_document', { p_document: doc.id, p_approve: true })).rejects.toThrow(/permission/i);
    await expect(as('hr').rpc('verify_employee_document', { p_document: doc.id, p_approve: false })).rejects.toThrow(/reason/);
    await as('hr').rpc('verify_employee_document', { p_document: doc.id, p_approve: false, p_reason: 'Scan is cut off' });
    expect((await notes('peer')).map((n) => n.title)).toContain('Document rejected: pan.pdf');
    await as('hr').rpc('verify_employee_document', { p_document: doc.id, p_approve: true });
    const history = await as('peer').rpc<{ action: string; status: string }[]>('document_history', { p_document: doc.id });
    expect(history.map((h) => h.status)).toEqual(['pending', 'rejected', 'verified']);
    await expect(as('mgr').rpc('document_history', { p_document: doc.id })).rejects.toThrow(/not found/);
    // verified documents cannot be deleted by the employee; other companies never see them
    await expect(as('peer').remove('employee_documents', doc.id)).rejects.toThrow();
    expect(await sql(pg, 'select 1 from employee_documents where id = $1', [doc.id])).toHaveLength(1);
    expect((await as('other').list({ table: 'employee_documents' })).rows).toHaveLength(0);
    expect((await as('mgr').list({ table: 'employee_documents', filters: [{ column: 'employee_id', op: 'eq', value: ids.peerEmp }] })).rows).toHaveLength(0);
    ids.expiringDoc = doc.id;
  });

  it('company documents: everyone reads "all", only HR/admin read "hr", only admins write', async () => {
    const mk = async (title: string, visibility: string) => {
      const path = `${ids.company}/company/${crypto.randomUUID()}/${title}.pdf`;
      await uploadAs(pg, ids.hr, 'documents', path);
      return as('hr').insert<{ id: string }>('company_documents', { company_id: ids.company, title, visibility, file_name: `${title}.pdf`, storage_path: path, expiry_date: addDays(today, 7) });
    };
    await mk('Leave policy', 'all');
    await mk('Salary bands', 'hr');
    expect((await as('peer').list<{ title: string }>({ table: 'company_documents' })).rows.map((d) => d.title)).toEqual(['Leave policy']);
    expect((await as('hr').list({ table: 'company_documents' })).rows).toHaveLength(2);
    expect((await as('other').list({ table: 'company_documents' })).rows).toHaveLength(0);
    await expect(uploadAs(pg, ids.peer, 'documents', `${ids.company}/company/x/evil.pdf`)).rejects.toThrow();
    await expect(as('peer').insert('company_documents', { company_id: ids.company, title: 'Fake', file_name: 'f.pdf', storage_path: `${ids.company}/company/x/f.pdf` })).rejects.toThrow();
  });

  it('daily jobs: absentees, expiry reminders — once per company per day, each reminder emailed', async () => {
    await sql(pg, 'delete from daily_job_runs');
    const first = await svc().rpc<{ absent_marked: number; reminders: number }>('run_daily_jobs');
    expect(first.absent_marked).toBeGreaterThanOrEqual(0); // absences may already be marked by the earlier run in this file
    expect(first.reminders).toBeGreaterThanOrEqual(2); // employee PAN in 30 days + company document in 7 days
    const [abs] = await sql<{ n: number }>(pg, "select count(*)::int n from attendance_records where employee_id = $1 and status = 'absent' and attendance_date < $2", [ids.mgrEmp, today]);
    expect(abs.n).toBeGreaterThan(0);
    expect(await sql(pg, 'select 1 from attendance_records where employee_id = $1 and attendance_date = $2', [ids.mgrEmp, today])).toHaveLength(0); // today is never auto-absent
    const again = await svc().rpc<{ absent_marked: number; reminders: number }>('run_daily_jobs');
    expect(again).toMatchObject({ absent_marked: 0, reminders: 0 });
    // HR got several generic notifications in that one run: every one is emailed, none is swallowed by the dedupe
    const [{ n: hrMails }] = await sql<{ n: number }>(pg, "select count(*)::int n from email_logs where to_email = 'hr@exit.test' and template_key = 'notification' and subject like '%expiring%'");
    expect(hrMails).toBeGreaterThanOrEqual(2);
    await expect(as('hr').rpc('run_daily_jobs')).rejects.toThrow();
  });

  it('overview dashboards and reports', async () => {
    const hr = await as('hr').rpc<{ total_employees: number; pending_resignations: number; expiring_documents: unknown[]; birthdays: { name: string }[] }>('hr_overview', { p_company: ids.company });
    expect(hr.total_employees).toBe(2); // Esha exited
    expect(hr.expiring_documents).toHaveLength(1);
    await expect(as('peer').rpc('hr_overview', { p_company: ids.company })).rejects.toThrow(/Permission/);
    const mine = await as('peer').rpc<{ documents: { total: number }; resignation: { status: string } }>('my_overview', { p_company: ids.company });
    expect(mine.documents.total).toBe(1);
    expect(mine.resignation.status).toBe('withdrawn');
    const exits = await as('hr').rpc<{ employee_name: string; status: string; settlement_status: string }[]>('report_exits', { p_company: ids.company, p_from: addDays(today, -1), p_to: today });
    expect(exits.find((x) => x.employee_name === 'Esha Test')).toMatchObject({ status: 'completed', settlement_status: 'paid' });
    expect((await as('hr').rpc<unknown[]>('report_documents', { p_company: ids.company })).length).toBeGreaterThan(0);
    await expect(as('peer').rpc('report_exits', { p_company: ids.company, p_from: today, p_to: today })).rejects.toThrow();
  });
});
