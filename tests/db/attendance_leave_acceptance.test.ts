// @vitest-environment node
// Acceptance checks for attendance and leave that complement hr.test.ts / hr_gaps.test.ts: worked-hours maths, automatic
// absences and their regularization, half-day leave balances, and that managers act only on their own team.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, serviceClient, sql } from './harness';

let pg: PGlite;
const ids: Record<string, string> = {};
const as = (u: string) => clientFor(pg, ids[u]);
let today = '';
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekday = (iso: string) => ![0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
const prevWeekday = (iso: string) => { let d = addDays(iso, -1); while (!isWeekday(d)) d = addDays(d, -1); return d; };
const nextWeekday = (iso: string) => { let d = addDays(iso, 1); while (!isWeekday(d)) d = addDays(d, 1); return d; };

async function employee(key: string, managerKey?: string) {
  const email = `${key}@att.test`;
  ids[`${key}Emp`] = (await as('hr').insert<{ id: string }>('employees', {
    company_id: ids.company, first_name: key, last_name: 'Test', email, joining_date: addDays(today, -60),
    ...(managerKey ? { manager_id: ids[`${managerKey}Emp`] } : {}),
  })).id;
  await as('hr').rpc('send_employee_login', { p_employee: ids[`${key}Emp`] });
  const [{ token }] = await sql<{ token: string }>(pg, 'select token from employee_activations where employee_id = $1', [ids[`${key}Emp`]]);
  ids[key] = await createUser(pg, email);
  await serviceClient(pg).rpc('consume_employee_activation', { p_token: token, p_user: ids[key] });
}

describe('attendance & leave acceptance', () => {
  beforeAll(async () => {
    pg = await createTestDb();
    ids.hr = await createUser(pg, 'hr@att.test');
    ids.company = await as('hr').rpc<string>('create_company', { p_name: 'Att Co', p_slug: 'att-co' });
    await sql(pg, "update companies set timezone = 'Asia/Kolkata' where id = $1", [ids.company]);
    [{ today }] = await sql<{ today: string }>(pg, "select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') today");
    await employee('lead');
    await employee('dev', 'lead');
    await employee('ops'); // not in the lead's team
  }, 180_000);

  it('working hours are computed from check-in/out (company time zone) and summed in the report', async () => {
    const day = prevWeekday(today);
    await as('hr').rpc('upsert_attendance', { p_company: ids.company, p_employee: ids.devEmp, p_date: day, p_status: 'present',
      p_check_in: `${day}T09:00:00+05:30`, p_check_out: `${day}T18:30:00+05:30` });
    const [r] = await sql<{ work_minutes: number; attendance_date: string }>(pg, "select work_minutes, to_char(attendance_date, 'YYYY-MM-DD') attendance_date from attendance_records where employee_id = $1 and attendance_date = $2", [ids.devEmp, day]);
    expect(r).toEqual({ work_minutes: 570, attendance_date: day });
    await expect(as('hr').rpc('upsert_attendance', { p_company: ids.company, p_employee: ids.devEmp, p_date: day, p_status: 'present',
      p_check_in: `${day}T18:00:00+05:30`, p_check_out: `${day}T09:00:00+05:30` })).rejects.toThrow();
    const rep = await as('hr').rpc<{ employee_name: string; total_hours: number }[]>('report_attendance', { p_company: ids.company, p_from: day, p_to: day });
    expect(rep.find((x) => x.employee_name === 'dev Test')?.total_hours).toBe(9.5);
    await expect(as('dev').rpc('clock_out', { p_company: ids.company })).rejects.toThrow(/not clocked in/);
  });

  it('a missed working day becomes absent automatically; an approved regularization replaces it', async () => {
    await serviceClient(pg).rpc('run_daily_jobs');
    const day = prevWeekday(prevWeekday(today));
    const [abs] = await sql<{ status: string; source: string }>(pg, 'select status, source from attendance_records where employee_id = $1 and attendance_date = $2', [ids.opsEmp, day]);
    expect(abs).toEqual({ status: 'absent', source: 'system' });
    const corr = await as('ops').rpc<string>('request_attendance_correction', { p_company: ids.company, p_date: day, p_status: 'present',
      p_check_in: `${day}T09:30:00+05:30`, p_check_out: `${day}T18:00:00+05:30`, p_reason: 'Forgot to clock in, was at client office' });
    await as('hr').rpc('decide_attendance_correction', { p_correction: corr, p_approve: true });
    const [fixed] = await sql<{ status: string; work_minutes: number }>(pg, 'select status, work_minutes from attendance_records where employee_id = $1 and attendance_date = $2', [ids.opsEmp, day]);
    expect(fixed).toEqual({ status: 'present', work_minutes: 510 });
  });

  it('half-day leave uses 0.5 days; the reporting manager (not another manager) decides; balance updates on approval only', async () => {
    const [lt] = await sql<{ id: string }>(pg, "select id from leave_types where company_id = $1 and code = 'CL'", [ids.company]);
    const day = nextWeekday(addDays(today, 7));
    const bal = async () => (await sql<{ used: number }>(pg, 'select used::float used from leave_balances where employee_id = $1 and leave_type_id = $2', [ids.devEmp, lt.id]))[0]?.used ?? 0;
    const before = await bal();
    await expect(as('dev').rpc('apply_leave', { p_company: ids.company, p_employee: ids.devEmp, p_type: lt.id, p_start: day, p_end: addDays(day, -1), p_half_day: false, p_reason: 'Wrong dates' })).rejects.toThrow(/End date/);
    const req = await as('dev').rpc<string>('apply_leave', { p_company: ids.company, p_employee: ids.devEmp, p_type: lt.id, p_start: day, p_end: day, p_half_day: true, p_reason: 'Doctor appointment' });
    const [r] = await sql<{ days: number }>(pg, 'select days::float days from leave_requests where id = $1', [req]);
    expect(r.days).toBe(0.5);
    await expect(as('dev').rpc('apply_leave', { p_company: ids.company, p_employee: ids.devEmp, p_type: lt.id, p_start: day, p_end: day, p_half_day: true, p_reason: 'Duplicate' })).rejects.toThrow(/overlapping/);
    // notification reached the reporting manager by email too
    expect(await sql(pg, "select 1 from email_logs where to_email = 'lead@att.test' and template_key = 'notification'")).not.toHaveLength(0);
    expect(await bal()).toBe(before); // pending does not consume
    await expect(as('ops').rpc('decide_leave', { p_request: req, p_approve: true })).rejects.toThrow(/not allowed/);
    await as('lead').rpc('decide_leave', { p_request: req, p_approve: true });
    expect(await bal()).toBe(before + 0.5);
    expect(await sql(pg, "select 1 from email_logs where to_email = 'dev@att.test' and template_key = 'leave_decision'")).toHaveLength(1);
  });

  it('managers see only their team; employees only themselves', async () => {
    const team = await as('lead').list<{ employee_id: string }>({ table: 'attendance_records' });
    const seen = new Set(team.rows.map((r) => r.employee_id));
    expect(seen.has(ids.devEmp)).toBe(true);
    expect(seen.has(ids.opsEmp)).toBe(false);
    const own = await as('ops').list<{ employee_id: string }>({ table: 'attendance_records' });
    expect(new Set(own.rows.map((r) => r.employee_id))).toEqual(new Set([ids.opsEmp]));
  });
});
