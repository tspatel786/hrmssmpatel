// @vitest-environment node
// Daily-operations journey: one company from sign-up to log-out, every step performed AS the user who does it in real
// life (RLS + permission checks on every call) against the real migrations, and every result read back from the database.
//   1 create company → 2 invite HR → 3 HR accepts and logs in → 4 HR creates departments, designations, employees
//   5 HR invites employees → 6 employee clocks in/out → 7 applies for leave → 8 manager approves
//   9 balances + attendance update → 10 recruitment → onboarding → 11 payroll → 12 employee payslip (PDF)
//   13 chat → 14 notifications → 15 signed-out access is refused
// Also checks the role dashboards from migration 1500 (each role sees only its own metrics, manager sees the team).
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { anonUpload, clientFor, createTestDb, createUser, serviceClient, sql, uploadAs, verifyJoiningDocuments } from './harness';
import { generatePayslipPdf } from '@/lib/pdf';

let pg: PGlite;
const ids: Record<string, string> = {};
const as = (who: string | null) => clientFor(pg, who === null ? null : ids[who]);
const isoDate = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const inMinutes = (m: number) => new Date(Date.now() + m * 60000).toISOString();

/** next Monday–Friday date at least `minDays` ahead */
function nextWorkday(minDays: number) {
  const d = new Date(Date.now() + minDays * 86400000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function roleId(name: string) {
  return (await sql<{ id: string }>(pg, `select id from roles where company_id = $1 and name = $2`, [ids.company, name]))[0].id;
}

beforeAll(async () => {
  pg = await createTestDb();
  ids.owner = await createUser(pg, 'owner@daily.test', 'Omar Owner');
}, 120_000);

describe('Daily operations journey (sign-up → daily work → sign-out)', () => {
  it('1. owner creates the company', async () => {
    ids.company = await as('owner').rpc<string>('create_company', { p_name: 'Daily Ops Ltd', p_slug: 'daily-ops' });
    const mine = await as('owner').rpc<{ id: string; is_admin: boolean }[]>('my_companies');
    expect(mine).toEqual([expect.objectContaining({ id: ids.company, is_admin: true })]);
  });

  it('2. owner invites an HR manager who has no account yet', async () => {
    const res = await as('owner').rpc<{ status: string }>('invite_member', {
      p_company: ids.company, p_email: 'hana@daily.test', p_role: await roleId('HR Manager'), p_base_url: 'http://localhost:5173',
    });
    expect(res.status).toBe('invited');
    const mail = await sql(pg, `select 1 from email_logs where company_id = $1 and to_email = 'hana@daily.test'`, [ids.company]);
    expect(mail.length).toBeGreaterThan(0);
  });

  it('3. HR signs up with the invited email, the invitation activates, and she sees only HR permissions', async () => {
    ids.hr = await createUser(pg, 'hana@daily.test', 'Hana HR');
    expect(await as('hr').rpc<number>('accept_my_invitations')).toBe(1);
    const perms = await as('hr').rpc<string[]>('my_permissions', { p_company: ids.company });
    expect(perms).toContain('employees.manage');
    expect(perms).not.toContain('settings.manage');
    expect(perms).not.toContain('users.manage');
  });

  it('4. HR creates a department, a designation and two employees (manager + report)', async () => {
    const hr = as('hr');
    ids.dept = (await hr.insert<{ id: string }>('departments', { company_id: ids.company, name: 'Field Operations', code: 'FOPS' })).id;
    ids.desig = (await hr.insert<{ id: string }>('designations', { company_id: ids.company, title: 'Operations Associate', level: 'L1' })).id;
    ids.mgrEmp = (await hr.insert<{ id: string }>('employees', {
      company_id: ids.company, first_name: 'Mira', last_name: 'Manager', email: 'mira@daily.test', joining_date: '2025-01-06',
      department_id: ids.dept, basic_monthly: 90000, hra_monthly: 36000, allowances_monthly: 24000,
    })).id;
    ids.emp = (await hr.insert<{ id: string }>('employees', {
      company_id: ids.company, first_name: 'Eli', last_name: 'Employee', email: 'eli@daily.test', joining_date: '2025-01-06',
      department_id: ids.dept, designation_id: ids.desig, manager_id: ids.mgrEmp,
      basic_monthly: 40000, hra_monthly: 16000, allowances_monthly: 4000,
    })).id;
    const rows = await sql<{ employee_code: string; manager_id: string | null }>(pg,
      `select employee_code, manager_id from employees where company_id = $1 order by employee_code`, [ids.company]);
    expect(rows).toEqual([{ employee_code: 'EMP-0001', manager_id: null }, { employee_code: 'EMP-0002', manager_id: ids.mgrEmp }]);
  });

  it('5. HR invites the employee (Employee role); the admin grants the manager a Hiring Manager role; both sign up and are linked', async () => {
    const hr = as('hr');
    // HR may only grant the Employee role, to the matching employee record (migration 1500) …
    await expect(hr.rpc('invite_member', { p_company: ids.company, p_email: 'mira@daily.test', p_role: await roleId('Hiring Manager'), p_employee: ids.mgrEmp }))
      .rejects.toThrow(/Only a Company Admin/);
    await expect(hr.rpc('invite_member', { p_company: ids.company, p_email: 'someone.else@daily.test', p_role: await roleId('Employee'), p_employee: ids.emp }))
      .rejects.toThrow(/must match/);
    expect((await hr.rpc<{ status: string }>('invite_member', { p_company: ids.company, p_email: 'eli@daily.test', p_role: await roleId('Employee'), p_employee: ids.emp })).status)
      .toBe('invited');
    // … privileged roles stay with the Company Admin
    await as('owner').rpc('invite_member', { p_company: ids.company, p_email: 'mira@daily.test', p_role: await roleId('Hiring Manager'), p_employee: ids.mgrEmp });
    ids.mgr = await createUser(pg, 'mira@daily.test', 'Mira Manager');
    ids.eli = await createUser(pg, 'eli@daily.test', 'Eli Employee');
    expect(await as('mgr').rpc<number>('accept_my_invitations')).toBe(1);
    expect(await as('eli').rpc<number>('accept_my_invitations')).toBe(1);
    const me = await as('eli').rpc<{ employee: { id: string; code: string } }>('my_dashboard', { p_company: ids.company });
    expect(me.employee).toMatchObject({ id: ids.emp, code: 'EMP-0002' });
    // an employee cannot read colleagues' salary records
    const visible = await as('eli').list({ table: 'employees', filters: [{ column: 'company_id', op: 'eq', value: ids.company }] });
    expect(visible.count).toBe(1);
  });

  it('6. employee clocks in and out; the record is saved and cannot be clocked twice', async () => {
    const eli = as('eli');
    await eli.rpc('clock_in', { p_company: ids.company });
    await expect(eli.rpc('clock_in', { p_company: ids.company })).rejects.toThrow(/already clocked in/i);
    await eli.rpc('clock_out', { p_company: ids.company });
    const today = await eli.rpc<{ today: { check_in: string | null; check_out: string | null } }>('my_dashboard', { p_company: ids.company });
    expect(today.today.check_in).toBeTruthy();
    expect(today.today.check_out).toBeTruthy();
    // the manager sees the direct report in the team dashboard (migration 1500)
    const team = await as('mgr').rpc<{ team_size: number; members: { id: string }[] }>('team_dashboard', { p_company: ids.company });
    expect(team.team_size).toBe(1);
    expect(team.members.map((m) => m.id)).toEqual([ids.emp]);
  });

  it('7. employee applies for one day of casual leave', async () => {
    ids.leaveDay = nextWorkday(10);
    ids.cl = (await sql<{ id: string }>(pg, `select id from leave_types where company_id = $1 and code = 'CL'`, [ids.company]))[0].id;
    ids.leave = await as('eli').rpc<string>('apply_leave', {
      p_company: ids.company, p_employee: null, p_type: ids.cl, p_start: ids.leaveDay, p_end: ids.leaveDay, p_half_day: false, p_reason: 'Family function',
    });
    const team = await as('mgr').rpc<{ pending_leave: number }>('team_dashboard', { p_company: ids.company });
    expect(team.pending_leave).toBe(1);
  });

  it('8. the employee cannot approve it; the line manager does', async () => {
    await expect(as('eli').rpc('decide_leave', { p_request: ids.leave, p_approve: true })).rejects.toThrow();
    await as('mgr').rpc('decide_leave', { p_request: ids.leave, p_approve: true, p_note: 'Approved' });
    const [r] = await sql<{ status: string }>(pg, `select status from leave_requests where id = $1`, [ids.leave]);
    expect(r.status).toBe('approved');
  });

  it('9. leave balance and attendance update automatically', async () => {
    const year = Number(ids.leaveDay.slice(0, 4));
    const [b] = await sql<{ used: number }>(pg, `select used::float as used from leave_balances where employee_id = $1 and leave_type_id = $2 and year = $3`, [ids.emp, ids.cl, year]);
    expect(b.used).toBe(1);
    const [a] = await sql<{ status: string }>(pg, `select status from attendance_records where employee_id = $1 and attendance_date = $2`, [ids.emp, ids.leaveDay]);
    expect(a.status).toBe('on_leave');
    const team = await as('mgr').rpc<{ pending_leave: number }>('team_dashboard', { p_company: ids.company });
    expect(team.pending_leave).toBe(0);
  });

  it('10. recruitment: HR requisition → manager approves → job → application → interview → feedback → offer → acceptance → onboarding → employee', async () => {
    const hr = as('hr'), mgr = as('mgr'), anon = as(null);
    const reqn = await hr.insert<{ id: string }>('job_requisitions', {
      company_id: ids.company, title: 'Operations Associate', department_id: ids.dept, headcount: 1, justification: 'Volume growth', status: 'draft',
    });
    await hr.update('job_requisitions', reqn.id, { status: 'pending_approval' });
    await mgr.update('job_requisitions', reqn.id, { status: 'approved', decision_note: 'Go ahead' }); // Hiring Manager approves (1500)
    const [rq] = await sql<{ status: string; approved_by: string }>(pg, `select status, approved_by from job_requisitions where id = $1`, [reqn.id]);
    expect(rq).toEqual({ status: 'approved', approved_by: ids.mgr });

    const job = await hr.insert<{ id: string }>('jobs', {
      company_id: ids.company, title: 'Operations Associate', department_id: ids.dept, location: 'Pune',
      description: 'Coordinate daily operations and vendor schedules.', status: 'published', hiring_manager_id: ids.mgr,
    });
    const path = `${ids.company}/incoming/${crypto.randomUUID()}/cv.pdf`;
    await anonUpload(pg, 'resumes', path);
    const appl = await anon.rpc<{ application_id: string }>('public_submit_application', {
      p_slug: 'daily-ops', p_job: job.id, p_data: { first_name: 'Nisha', last_name: 'Newhire', email: 'nisha@example.com', phone: '9876500011' },
      p_resume: { path, name: 'cv.pdf', size: 1000, mime: 'application/pdf' },
    });
    await hr.rpc('change_application_stage', { p_application: appl.application_id, p_stage: 'shortlisted' });
    const interview = await hr.rpc<string>('schedule_interview', {
      p_application: appl.application_id, p_round: 'Manager round', p_type: 'video', p_at: inMinutes(15), p_duration: 45,
      p_location: '', p_meeting_link: 'https://meet.example.com/x', p_panelists: [ids.mgr],
    });
    await mgr.rpc('submit_interview_feedback', {
      p_interview: interview, p_overall: 4, p_technical: 4, p_communication: 5, p_culture: 4,
      p_recommendation: 'hire', p_strengths: 'Organised', p_weaknesses: 'None', p_comments: 'Hire',
    });
    await hr.rpc('change_application_stage', { p_application: appl.application_id, p_stage: 'selected' });
    const offer = await hr.insert<{ id: string }>('offers', {
      company_id: ids.company, application_id: appl.application_id, ctc_annual: 600000, basic_monthly: 25000, hra_monthly: 10000,
      allowances_monthly: 15000, joining_date: isoDate(14), expiry_date: isoDate(7), work_location: 'Pune',
    });
    expect(await hr.rpc<string>('submit_offer_for_approval', { p_offer: offer.id })).toBe('pending_approval');
    await mgr.rpc('decide_offer', { p_offer: offer.id, p_approve: true, p_comments: 'Within budget' }); // manager approves the offer
    const pdfPath = `${ids.company}/offers/${offer.id}.pdf`;
    await uploadAs(pg, ids.hr, 'documents', pdfPath);
    const sent = await hr.rpc<{ offer_link: string }>('send_offer', { p_offer: offer.id, p_base_url: 'http://localhost:5173', p_pdf_path: pdfPath });
    const token = sent.offer_link.split('/').pop()!;
    expect((await anon.rpc<{ status: string }>('public_respond_offer', { p_token: token, p_accept: true, p_signature: 'Nisha Newhire' })).status).toBe('accepted');
    const [onb] = await sql<{ id: string }>(pg, `select id from onboardings where offer_id = $1`, [offer.id]);
    await hr.rpc('confirm_joining', { p_onboarding: onb.id, p_joining_date: isoDate(14) });
    const tasks = await hr.list<{ id: string }>({ table: 'onboarding_tasks', filters: [{ column: 'onboarding_id', op: 'eq', value: onb.id }] });
    for (const t of tasks.rows) await hr.update('onboarding_tasks', t.id, { is_completed: true });
    await verifyJoiningDocuments(pg, ids.hr, onb.id);
    const newEmp = await hr.rpc<string>('complete_onboarding', { p_onboarding: onb.id, p_base_url: 'http://localhost:5173' });
    const [e] = await sql<{ email: string; department_id: string }>(pg, `select email, department_id from employees where id = $1`, [newEmp]);
    expect(e).toEqual({ email: 'nisha@example.com', department_id: ids.dept });
    // HRMS access: the credentials email carries the Employee ID and a one-time set-password link; the employee-auth
    // edge function creates the account and consumes the token, which links the new hire as Employee
    const welcome = await sql<{ id: string }>(pg, `select id from email_logs where company_id = $1 and template_key = 'employee_credentials' and to_email = 'nisha@example.com'`, [ids.company]);
    expect(welcome).toHaveLength(1);
    const [{ token: activation }] = await sql<{ token: string }>(pg, 'select token from employee_activations where employee_id = $1', [newEmp]);
    // HR can read employee records but never the one-time token
    await expect(hr.list({ table: 'employee_activations' })).rejects.toThrow();
    expect((await anon.rpc<{ status: string; employee_code: string }>('public_employee_activation', { p_token: activation })).status).toBe('valid');
    const nisha = await createUser(pg, 'nisha@example.com', 'Nisha Newhire');
    expect(await serviceClient(pg).rpc<string>('consume_employee_activation', { p_token: activation, p_user: nisha })).toBe(ids.company);
    expect((await anon.rpc<{ status: string }>('public_employee_activation', { p_token: activation })).status).toBe('invalid'); // token cleared
    const me = await clientFor(pg, nisha).rpc<{ employee: { id: string } }>('my_dashboard', { p_company: ids.company });
    expect(me.employee.id).toBe(newEmp);
    const [m] = await sql<{ role: string }>(pg, `select r.name role from company_members m join roles r on r.id = m.role_id where m.company_id = $1 and m.user_id = $2`, [ids.company, nisha]);
    expect(m.role).toBe('Employee');
  });

  it('11. a payroll manager generates, checks, processes and pays last month\'s payroll', async () => {
    await as('owner').rpc('invite_member', { p_company: ids.company, p_email: 'paul@daily.test', p_role: await roleId('Payroll Manager') });
    ids.pay = await createUser(pg, 'paul@daily.test', 'Paul Payroll');
    expect(await as('pay').rpc<number>('accept_my_invitations')).toBe(1);
    const last = new Date(); last.setUTCDate(1); last.setUTCMonth(last.getUTCMonth() - 1);
    ids.run = await as('pay').rpc<string>('generate_payroll', { p_company: ids.company, p_year: last.getUTCFullYear(), p_month: last.getUTCMonth() + 1 });
    const slips = await as('pay').list<{ employee_id: string; gross: number; pf: number; lop_days: number; net_pay: number }>({
      table: 'v_payslips', filters: [{ column: 'payroll_run_id', op: 'eq', value: ids.run }],
    });
    const eli = slips.rows.find((s) => s.employee_id === ids.emp)!;
    expect(eli.lop_days).toBe(0);
    expect(eli.gross).toBeCloseTo(40000 + 16000 + 4000, 1); // full month: basic + HRA + allowances
    expect(eli.pf).toBeCloseTo(40000 * 0.12, 1); // default PF 12 % of basic
    expect(eli.net_pay).toBeLessThan(eli.gross);
    await as('pay').rpc('finalize_payroll', { p_run: ids.run });
    await as('pay').rpc('mark_payroll_paid', { p_run: ids.run });
    const [run] = await sql<{ status: string }>(pg, `select status from payroll_runs where id = $1`, [ids.run]);
    expect(run.status).toBe('paid');
  });

  it('12. the employee sees only their own payslip and downloads it as a PDF', async () => {
    const mine = await as('eli').list<Record<string, unknown> & { employee_id: string }>({
      table: 'v_payslips', filters: [{ column: 'company_id', op: 'eq', value: ids.company }],
    });
    expect(mine.rows.map((r) => r.employee_id)).toEqual([ids.emp]);
    const company = await as('eli').get<Record<string, unknown>>('companies', ids.company);
    const pdf = generatePayslipPdf({ ...(mine.rows[0] as object), company } as unknown as Parameters<typeof generatePayslipPdf>[0]);
    const head = new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0, 5));
    expect(head).toBe('%PDF-');
  });

  it('13. colleagues chat: direct message with unread count, read receipt, group chat', async () => {
    const dm = await as('eli').rpc<string>('chat_start_direct', { p_company: ids.company, p_user: ids.mgr });
    await as('eli').rpc('chat_send_message', { p_conversation: dm, p_body: 'Thanks for approving my leave!', p_client_id: 'daily-0001' });
    const before = await as('mgr').rpc<{ id: string; unread_count: number }[]>('chat_my_conversations', { p_company: ids.company });
    expect(before.find((c) => c.id === dm)?.unread_count).toBe(1);
    await as('mgr').rpc('chat_mark_read', { p_conversation: dm });
    const after = await as('mgr').rpc<{ id: string; unread_count: number }[]>('chat_my_conversations', { p_company: ids.company });
    expect(after.find((c) => c.id === dm)?.unread_count).toBe(0);
    const group = await as('hr').rpc<string>('chat_create_group', { p_company: ids.company, p_name: 'Operations', p_description: 'Daily ops', p_members: [ids.mgr, ids.eli] });
    await as('hr').rpc('chat_send_message', { p_conversation: group, p_body: 'Stand-up at 10', p_client_id: 'daily-0002' });
    const eliConvs = await as('eli').rpc<{ id: string; unread_count: number }[]>('chat_my_conversations', { p_company: ids.company });
    expect(eliConvs.find((c) => c.id === group)?.unread_count).toBe(1);
    // the payroll manager is not in either conversation and cannot read them
    const outsider = await as('pay').list({ table: 'chat_messages', filters: [{ column: 'conversation_id', op: 'in', value: [dm, group] }] });
    expect(outsider.count).toBe(0);
  });

  it('14. users receive notifications (leave decision, announcement) and can mark them read', async () => {
    const leaveNote = await as('eli').list<{ type: string }>({ table: 'notifications', filters: [{ column: 'user_id', op: 'eq', value: ids.eli }, { column: 'type', op: 'eq', value: 'leave' }] });
    expect(leaveNote.count).toBeGreaterThan(0);
    await as('hr').insert('announcements', { company_id: ids.company, title: 'Office closed Friday', body: 'Maintenance work.', requires_ack: true });
    const ann = await as('eli').list({ table: 'notifications', filters: [{ column: 'user_id', op: 'eq', value: ids.eli }, { column: 'type', op: 'eq', value: 'announcement' }] });
    expect(ann.count).toBe(1);
    await as('eli').rpc('mark_notifications_read', { p_ids: null });
    const unread = await sql(pg, `select 1 from notifications where user_id = $1 and read_at is null`, [ids.eli]);
    expect(unread).toHaveLength(0);
  });

  it('15. after signing out (anonymous), every protected record is refused', async () => {
    const anon = as(null);
    for (const table of ['employees', 'attendance_records', 'leave_requests', 'payslips', 'chat_messages', 'notifications', 'job_requisitions']) {
      const seen = await anon.list({ table, filters: [{ column: 'company_id', op: 'eq', value: ids.company }] }).then((r) => r.count, () => 0);
      expect(seen, table).toBe(0);
    }
    await expect(anon.rpc('my_dashboard', { p_company: ids.company })).rejects.toThrow();
    await expect(anon.rpc('team_dashboard', { p_company: ids.company })).rejects.toThrow();
  });
});

describe('Role dashboards (migration 1500): each role gets only its own metrics', () => {
  type Stats = { sections: Record<string, boolean>; last_payroll: unknown; pipeline: unknown; headcount: number | null; present_today: number | null };

  it('HR manager sees every company section', async () => {
    const s = await as('hr').rpc<Stats>('dashboard_stats', { p_company: ids.company });
    expect(Object.values(s.sections).every(Boolean)).toBe(true);
    expect(s.last_payroll).not.toBeNull();
    expect(s.headcount).toBe(3);
  });

  it('payroll manager sees payroll, attendance and people, but no recruitment funnel', async () => {
    const s = await as('pay').rpc<Stats>('dashboard_stats', { p_company: ids.company });
    expect(s.last_payroll).not.toBeNull();
    expect(s.present_today).not.toBeNull();
    expect(s.pipeline).toBeNull();
    expect(s.sections.recruitment).toBe(false);
  });

  it('hiring manager sees recruitment and people, but never company payroll totals', async () => {
    const s = await as('mgr').rpc<Stats>('dashboard_stats', { p_company: ids.company });
    expect(s.pipeline).not.toBeNull();
    expect(s.last_payroll).toBeNull();
    expect(s.sections.payroll).toBe(false);
    expect(s.present_today).toBeNull(); // no attendance.view: the team view covers their own reports
  });

  it('employee has no company dashboard, only self-service; a non-manager has an empty team', async () => {
    await expect(as('eli').rpc('dashboard_stats', { p_company: ids.company })).rejects.toThrow();
    const team = await as('eli').rpc<{ team_size: number }>('team_dashboard', { p_company: ids.company });
    expect(team.team_size).toBe(0);
  });

  it('platform super admin sees platform-wide statistics; company users cannot', async () => {
    await sql(pg, `insert into platform_admins (user_id) values ($1)`, [ids.owner]);
    const p = await as('owner').rpc<{ companies: number; users: number }>('admin_platform_stats', {});
    expect(p.companies).toBeGreaterThanOrEqual(1);
    expect(p.users).toBeGreaterThanOrEqual(5);
    await expect(as('hr').rpc('admin_platform_stats', {})).rejects.toThrow();
  });
});
