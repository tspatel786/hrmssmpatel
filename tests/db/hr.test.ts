// @vitest-environment node
// Attendance, leave and payroll business rules.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, sql } from './harness';

let pg: PGlite;
let owner: string, managerUser: string, empUser: string;
let company: string, empId: string, mgrId: string, clId: string, lopId: string;
const db = (u: string) => clientFor(pg, u);

beforeAll(async () => {
  pg = await createTestDb();
  owner = await createUser(pg, 'owner@hr.test', 'Olivia Owner');
  managerUser = await createUser(pg, 'mgr@hr.test', 'Manny Manager');
  empUser = await createUser(pg, 'emp@hr.test', 'Erin Employee');
  company = await db(owner).rpc<string>('create_company', { p_name: 'HR Co', p_slug: 'hr-co' });
  // Monday-Friday, no holidays by default
  mgrId = (await db(owner).insert<{ id: string }>('employees', {
    company_id: company, first_name: 'Manny', last_name: 'Manager', email: 'mgr@hr.test', joining_date: '2024-01-01',
    basic_monthly: 80000, hra_monthly: 30000, allowances_monthly: 20000,
  })).id;
  empId = (await db(owner).insert<{ id: string }>('employees', {
    company_id: company, first_name: 'Erin', last_name: 'Employee', email: 'emp@hr.test', joining_date: '2024-01-01',
    manager_id: mgrId, basic_monthly: 40000, hra_monthly: 16000, allowances_monthly: 4000, fixed_deductions_monthly: 500,
  })).id;
  // employees sign up -> linked automatically by matching work email
  expect(await db(managerUser).rpc<number>('accept_my_invitations')).toBe(1);
  expect(await db(empUser).rpc<number>('accept_my_invitations')).toBe(1);
  clId = (await sql<{ id: string }>(pg, `select id from leave_types where company_id = $1 and code = 'CL'`, [company]))[0].id;
  lopId = (await sql<{ id: string }>(pg, `select id from leave_types where company_id = $1 and code = 'LOP'`, [company]))[0].id;
});

describe('Employees', () => {
  it('auto-generates sequential employee codes', async () => {
    const rows = await sql<{ employee_code: string }>(pg, `select employee_code from employees where company_id = $1 order by employee_code`, [company]);
    expect(rows.map((r) => r.employee_code)).toEqual(['EMP-0001', 'EMP-0002']);
  });

  it('enforces unique work email per company', async () => {
    await expect(db(owner).insert('employees', { company_id: company, first_name: 'Dup', email: 'EMP@hr.test' })).rejects.toThrow(/already exists/);
  });

  it('enforces the plan employee limit', async () => {
    await pg.query(`update companies set max_employees = 2 where id = $1`, [company]);
    await expect(db(owner).insert('employees', { company_id: company, first_name: 'Third', email: 'third@hr.test' })).rejects.toThrow(/limit reached/);
    await pg.query(`update companies set max_employees = 50 where id = $1`, [company]);
  });
});

describe('Attendance', () => {
  it('employee clocks in and out once per day', async () => {
    await db(empUser).rpc('clock_in', { p_company: company });
    await expect(db(empUser).rpc('clock_in', { p_company: company })).rejects.toThrow(/already clocked in/);
    await db(empUser).rpc('clock_out', { p_company: company });
    await expect(db(empUser).rpc('clock_out', { p_company: company })).rejects.toThrow(/already clocked out/);
    const mine = await db(empUser).list<{ status: string; check_out: string }>({ table: 'v_attendance', filters: [{ column: 'employee_id', op: 'eq', value: empId }] });
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0].status).toBe('half_day'); // < 4 hours worked
  });

  it('users without an employee profile cannot clock in', async () => {
    await expect(db(owner).rpc('clock_in', { p_company: company })).rejects.toThrow(/not linked/);
  });

  it('HR can mark attendance; future dates are rejected; employees cannot', async () => {
    await db(owner).rpc('upsert_attendance', { p_company: company, p_employee: empId, p_date: '2025-03-03', p_status: 'absent' });
    await expect(db(owner).rpc('upsert_attendance', { p_company: company, p_employee: empId, p_date: '2099-01-01', p_status: 'present' }))
      .rejects.toThrow(/future/);
    await expect(db(empUser).rpc('upsert_attendance', { p_company: company, p_employee: empId, p_date: '2025-03-04', p_status: 'present' }))
      .rejects.toThrow(/attendance.manage/);
  });

  it('manager can see their direct report attendance', async () => {
    const res = await db(managerUser).list({ table: 'v_attendance', filters: [{ column: 'employee_id', op: 'eq', value: empId }] });
    expect(res.count).toBeGreaterThan(0);
  });
});

describe('Leave', () => {
  let reqId: string;
  it('computes working days excluding weekends and holidays', async () => {
    await db(owner).insert('holidays', { company_id: company, name: 'Founders Day', holiday_date: '2026-03-04' });
    // Mon 2 Mar – Fri 6 Mar 2026 minus Wed holiday = 4 days
    reqId = await db(empUser).rpc<string>('apply_leave', {
      p_company: company, p_employee: null, p_type: clId, p_start: '2026-03-02', p_end: '2026-03-06', p_half_day: false, p_reason: 'Family trip',
    });
    const [r] = await sql<{ days: number }>(pg, `select days::float as days from leave_requests where id = $1`, [reqId]);
    expect(r.days).toBe(4);
  });

  it('rejects overlapping requests, weekend-only requests and insufficient balance', async () => {
    await expect(db(empUser).rpc('apply_leave', { p_company: company, p_employee: null, p_type: clId, p_start: '2026-03-05', p_end: '2026-03-05', p_half_day: false, p_reason: 'Overlap' }))
      .rejects.toThrow(/overlapping/);
    await expect(db(empUser).rpc('apply_leave', { p_company: company, p_employee: null, p_type: clId, p_start: '2026-03-07', p_end: '2026-03-08', p_half_day: false, p_reason: 'Weekend' }))
      .rejects.toThrow(/weekends or holidays/);
    await expect(db(empUser).rpc('apply_leave', { p_company: company, p_employee: null, p_type: clId, p_start: '2026-04-01', p_end: '2026-04-14', p_half_day: false, p_reason: 'Too long' }))
      .rejects.toThrow(/Insufficient/);
  });

  it('employee cannot approve own leave; manager can approve direct report', async () => {
    await expect(db(empUser).rpc('decide_leave', { p_request: reqId, p_approve: true })).rejects.toThrow(/not allowed/);
    await db(managerUser).rpc('decide_leave', { p_request: reqId, p_approve: true, p_note: 'Enjoy!' });
    const [b] = await sql<{ used: number }>(pg, `select used::float as used from leave_balances where employee_id = $1 and leave_type_id = $2 and year = 2026`, [empId, clId]);
    expect(b.used).toBe(4);
    const att = await sql(pg, `select 1 from attendance_records where employee_id = $1 and status = 'on_leave' and attendance_date between '2026-03-02' and '2026-03-06'`, [empId]);
    expect(att).toHaveLength(4);
    const mail = await sql(pg, `select 1 from email_logs where related_id = $1 and template_key = 'leave_decision'`, [reqId]);
    expect(mail).toHaveLength(1);
    const notif = await db(empUser).list({ table: 'notifications', filters: [{ column: 'user_id', op: 'eq', value: empUser }] });
    expect(notif.count).toBeGreaterThan(0);
  });

  it('cancelling an approved leave restores the balance', async () => {
    await db(owner).rpc('cancel_leave', { p_request: reqId });
    const [b] = await sql<{ used: number }>(pg, `select used::float as used from leave_balances where employee_id = $1 and leave_type_id = $2 and year = 2026`, [empId, clId]);
    expect(b.used).toBe(0);
  });

  it('allocates balances for the year with carry forward', async () => {
    const n = await db(owner).rpc<number>('allocate_leave_balances', { p_company: company, p_year: 2027 });
    expect(n).toBe(6); // 2 employees x 3 paid types
  });
});

describe('Payroll', () => {
  let runId: string;
  it('generates payslips with LOP for unpaid leave and absences', async () => {
    // March 2025: 21 working days (Mon-Fri). Erin absent on 3 Mar (marked above) + 1 day LOP leave
    const lop = await db(owner).rpc<string>('apply_leave', {
      p_company: company, p_employee: empId, p_type: lopId, p_start: '2025-03-10', p_end: '2025-03-10', p_half_day: false, p_reason: 'Personal work',
    });
    await db(owner).rpc('decide_leave', { p_request: lop, p_approve: true });
    runId = await db(owner).rpc<string>('generate_payroll', { p_company: company, p_year: 2025, p_month: 3 });
    const slips = await db(owner).list<{ employee_id: string; working_days: number; paid_days: number; lop_days: number; gross: number; pf: number; professional_tax: number; net_pay: number; other_deductions: number }>({
      table: 'v_payslips', filters: [{ column: 'payroll_run_id', op: 'eq', value: runId }],
    });
    expect(slips.count).toBe(2);
    const erin = slips.rows.find((s) => s.employee_id === empId)!;
    expect(erin.working_days).toBe(21);
    expect(erin.lop_days).toBe(2);
    expect(erin.paid_days).toBe(19);
    const factor = 19 / 21;
    expect(erin.gross).toBeCloseTo(Math.round(40000 * factor * 100) / 100 + Math.round(16000 * factor * 100) / 100 + Math.round(4000 * factor * 100) / 100, 1);
    expect(erin.pf).toBeCloseTo(Math.round(40000 * factor * 0.12 * 100) / 100, 1);
    expect(erin.professional_tax).toBe(200);
    expect(erin.other_deductions).toBe(500);
    expect(erin.net_pay).toBeCloseTo(erin.gross - erin.pf - 200 - 500, 1);
  });

  it('employees cannot see draft payslips, but can after processing', async () => {
    expect((await db(empUser).list({ table: 'v_payslips', filters: [{ column: 'employee_id', op: 'eq', value: empId }] })).count).toBe(0);
    await db(owner).rpc('finalize_payroll', { p_run: runId });
    const mine = await db(empUser).list<{ employee_id: string }>({ table: 'v_payslips', filters: [{ column: 'company_id', op: 'eq', value: company }] });
    expect(mine.rows.map((r) => r.employee_id)).toEqual([empId]);
    const emails = await sql(pg, `select 1 from email_logs where template_key = 'payslip_available' and company_id = $1`, [company]);
    expect(emails).toHaveLength(2);
  });

  it('processed payroll is locked; can be marked paid', async () => {
    await expect(db(owner).rpc('generate_payroll', { p_company: company, p_year: 2025, p_month: 3 })).rejects.toThrow(/already processed/);
    await expect(db(owner).remove('payroll_runs', runId)).rejects.toThrow();
    await db(owner).rpc('mark_payroll_paid', { p_run: runId });
    const [r] = await sql<{ status: string; employee_count: number }>(pg, `select status, employee_count from payroll_runs where id = $1`, [runId]);
    expect(r).toEqual({ status: 'paid', employee_count: 2 });
  });

  it('rejects future months', async () => {
    await expect(db(owner).rpc('generate_payroll', { p_company: company, p_year: 2099, p_month: 1 })).rejects.toThrow(/future month/);
  });
});

describe('Dashboards & reports', () => {
  it('returns real aggregated statistics', async () => {
    const s = await db(owner).rpc<Record<string, unknown>>('dashboard_stats', { p_company: company });
    expect(s.headcount).toBe(2);
    expect((s.attendance_trend as unknown[]).length).toBe(14);
    const me = await db(empUser).rpc<{ employee: { code: string }; leave_balances: unknown[] }>('my_dashboard', { p_company: company });
    expect(me.employee.code).toBe('EMP-0002');
    await expect(db(empUser).rpc('dashboard_stats', { p_company: company })).rejects.toThrow(/dashboard.view/);
  });

  it('reports return rows and enforce permission', async () => {
    const hc = await db(owner).rpc<unknown[]>('report_headcount', { p_company: company });
    expect(hc.length).toBeGreaterThan(0);
    const att = await db(owner).rpc<{ absent: number }[]>('report_attendance', { p_company: company, p_from: '2025-03-01', p_to: '2025-03-31' });
    expect(att.some((r) => r.absent === 1)).toBe(true);
    const lv = await db(owner).rpc<unknown[]>('report_leave', { p_company: company, p_year: 2026 });
    expect(lv.length).toBeGreaterThan(0);
    expect(await db(owner).rpc<unknown[]>('report_recruitment', { p_company: company, p_from: '2025-01-01', p_to: '2030-01-01' })).toEqual([]);
    await expect(db(empUser).rpc('report_headcount', { p_company: company })).rejects.toThrow(/reports.view/);
  });

  it('test emails are rendered from templates and logged', async () => {
    const id = await db(owner).rpc<string>('send_test_email', { p_company: company, p_template: 'offer_letter', p_to: 'qa@example.com' });
    const [l] = await sql<{ subject: string; body_html: string; status: string }>(pg, `select subject, body_html, status from email_logs where id = $1`, [id]);
    expect(l.status).toBe('queued');
    expect(l.subject).toBe('Your offer from HR Co — Software Engineer');
    expect(l.body_html).toContain('Alex Candidate');
    expect(l.body_html).not.toContain('{{');
  });

  it('marks notifications read', async () => {
    const n = await db(empUser).rpc<number>('mark_notifications_read', { p_ids: null });
    expect(n).toBeGreaterThan(0);
  });
});
