// @vitest-environment node
// Attendance late/early flags, attendance correction requests and the team leave calendar (migration 1300).
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, sql } from './harness';

let pg: PGlite;
let owner: string, mgrUser: string, empUser: string, mateUser: string, otherUser: string, rival: string;
let company: string, mgrId: string, empId: string, otherId: string;
const db = (u: string) => clientFor(pg, u);

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86400000));
function nextMonday(minDaysAhead = 7) {
  const d = new Date(Date.now() + minDaysAhead * 86400000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d);
}

beforeAll(async () => {
  pg = await createTestDb();
  owner = await createUser(pg, 'owner@gap.test', 'Olive Owner');
  mgrUser = await createUser(pg, 'mgr@gap.test', 'Max Manager');
  empUser = await createUser(pg, 'emp@gap.test', 'Ella Employee');
  mateUser = await createUser(pg, 'mate@gap.test', 'Mia Mate');
  otherUser = await createUser(pg, 'other@gap.test', 'Omar Other');
  rival = await createUser(pg, 'rival@gap.test', 'Rex Rival');
  company = await db(owner).rpc<string>('create_company', { p_name: 'Gap Co', p_slug: 'gap-co' });
  await db(rival).rpc<string>('create_company', { p_name: 'Rival Gap', p_slug: 'rival-gap' });
  const depts = await sql<{ id: string }>(pg, `select id from departments where company_id = $1 order by name limit 2`, [company]);
  const mk = (first: string, email: string, extra: Record<string, unknown> = {}) =>
    db(owner).insert<{ id: string }>('employees', { company_id: company, first_name: first, last_name: 'Test', email, joining_date: '2024-01-01', basic_monthly: 30000, ...extra });
  mgrId = (await mk('Max', 'mgr@gap.test', { department_id: depts[0].id })).id;
  empId = (await mk('Ella', 'emp@gap.test', { department_id: depts[0].id, manager_id: mgrId })).id;
  await mk('Mia', 'mate@gap.test', { department_id: depts[0].id });
  otherId = (await mk('Omar', 'other@gap.test', { department_id: depts[1].id })).id;
  for (const u of [mgrUser, empUser, mateUser, otherUser]) expect(await db(u).rpc<number>('accept_my_invitations')).toBe(1);
});

describe('Late arrival / early departure flags', () => {
  it('flags late check-in and early check-out beyond the grace period (company time zone)', async () => {
    const d = daysAgo(5);
    await db(owner).rpc('upsert_attendance', { p_company: company, p_employee: empId, p_date: d, p_status: 'present',
      p_check_in: `${d}T09:55:00+05:30`, p_check_out: `${d}T17:00:00+05:30` });
    const [r] = (await db(owner).list<{ is_late: boolean; late_minutes: number; is_early_exit: boolean; early_exit_minutes: number }>({
      table: 'v_attendance', filters: [{ column: 'employee_id', op: 'eq', value: empId }, { column: 'attendance_date', op: 'eq', value: d }] })).rows;
    expect(r).toMatchObject({ is_late: true, late_minutes: 25, is_early_exit: true, early_exit_minutes: 90 });
  });

  it('within the grace period is not late; leave days are never flagged', async () => {
    const d = daysAgo(6);
    await db(owner).rpc('upsert_attendance', { p_company: company, p_employee: empId, p_date: d, p_status: 'present',
      p_check_in: `${d}T09:38:00+05:30`, p_check_out: `${d}T18:45:00+05:30` });
    const d2 = daysAgo(7);
    await db(owner).rpc('upsert_attendance', { p_company: company, p_employee: empId, p_date: d2, p_status: 'on_leave' });
    const rows = await sql<{ attendance_date: string; is_late: boolean; is_early_exit: boolean }>(pg,
      `select attendance_date::text, is_late, is_early_exit from attendance_records where employee_id = $1 and attendance_date in ($2, $3)`, [empId, d, d2]);
    expect(rows.every((x) => !x.is_late && !x.is_early_exit)).toBe(true);
  });

  it('grace period is configurable per company and the attendance report counts late arrivals', async () => {
    const [{ n }] = await sql<{ n: number }>(pg, `select count(*)::int n from attendance_records where employee_id = $1 and is_late`, [empId]);
    expect(n).toBe(1);
    const rep = await db(owner).rpc<{ employee_code: string; late_arrivals: number; early_departures: number }[]>('report_attendance', { p_company: company, p_from: daysAgo(30), p_to: daysAgo(0) });
    const mine = rep.find((x) => Number(x.late_arrivals) > 0)!;
    expect(Number(mine.late_arrivals)).toBe(1);
    expect(Number(mine.early_departures)).toBe(1);
  });
});

describe('Attendance correction requests', () => {
  let corr: string;
  it('employee requests a correction; validation rules apply', async () => {
    const d = daysAgo(5);
    await expect(db(empUser).rpc('request_attendance_correction', { p_company: company, p_date: '2099-01-01', p_status: 'present', p_check_in: '2099-01-01T09:30:00+05:30', p_check_out: null, p_reason: 'future date' })).rejects.toThrow(/past or current/);
    await expect(db(empUser).rpc('request_attendance_correction', { p_company: company, p_date: daysAgo(90), p_status: 'present', p_check_in: `${daysAgo(90)}T09:30:00+05:30`, p_check_out: null, p_reason: 'too old date' })).rejects.toThrow(/60 days/);
    await expect(db(empUser).rpc('request_attendance_correction', { p_company: company, p_date: d, p_status: 'present', p_check_in: null, p_check_out: null, p_reason: 'missing time' })).rejects.toThrow(/Check-in time is required/);
    await expect(db(empUser).rpc('request_attendance_correction', { p_company: company, p_date: d, p_status: 'present', p_check_in: `${d}T18:00:00+05:30`, p_check_out: `${d}T09:00:00+05:30`, p_reason: 'reversed times' })).rejects.toThrow(/after check-in/);
    await expect(db(owner).rpc('request_attendance_correction', { p_company: company, p_date: d, p_status: 'present', p_check_in: `${d}T09:30:00+05:30`, p_check_out: null, p_reason: 'no employee profile' })).rejects.toThrow(/not linked/);
    corr = await db(empUser).rpc<string>('request_attendance_correction', { p_company: company, p_date: d, p_status: 'present',
      p_check_in: `${d}T09:30:00+05:30`, p_check_out: `${d}T18:30:00+05:30`, p_reason: 'Biometric device was down in the morning' });
    await expect(db(empUser).rpc('request_attendance_correction', { p_company: company, p_date: d, p_status: 'present', p_check_in: `${d}T09:30:00+05:30`, p_check_out: null, p_reason: 'duplicate request' })).rejects.toThrow(/pending correction/);
    // the reviewer gets the original values as a snapshot + a notification
    const [row] = (await db(mgrUser).list<{ original_status: string; status: string }>({ table: 'v_attendance_corrections', filters: [{ column: 'id', op: 'eq', value: corr }] })).rows;
    expect(row).toMatchObject({ original_status: 'present', status: 'pending' });
    expect((await db(mgrUser).list({ table: 'notifications', filters: [{ column: 'type', op: 'eq', value: 'attendance' }] })).count).toBe(1);
  });

  it('visibility: employee, their manager and HR — not colleagues or other companies; direct writes blocked', async () => {
    for (const u of [mateUser, otherUser, rival]) {
      expect((await db(u).list({ table: 'v_attendance_corrections', filters: [{ column: 'id', op: 'eq', value: corr }] })).count).toBe(0);
    }
    expect((await db(owner).list({ table: 'v_attendance_corrections', filters: [{ column: 'id', op: 'eq', value: corr }] })).count).toBe(1);
    await expect(db(empUser).update('attendance_corrections', corr, { status: 'approved' })).rejects.toThrow();
  });

  it('only the manager or HR can decide — never the employee or a colleague', async () => {
    await expect(db(empUser).rpc('decide_attendance_correction', { p_correction: corr, p_approve: true })).rejects.toThrow(/not allowed/);
    await expect(db(mateUser).rpc('decide_attendance_correction', { p_correction: corr, p_approve: true })).rejects.toThrow(/not allowed/);
    await expect(db(rival).rpc('decide_attendance_correction', { p_correction: corr, p_approve: true })).rejects.toThrow(/not allowed/);
    await expect(db(mgrUser).rpc('decide_attendance_correction', { p_correction: corr, p_approve: false })).rejects.toThrow(/reason for rejecting/);
  });

  it('approval rewrites the attendance record (flags recomputed) and notifies the employee', async () => {
    await db(mgrUser).rpc('decide_attendance_correction', { p_correction: corr, p_approve: true, p_note: 'Confirmed with security log' });
    const [a] = await sql<{ is_late: boolean; is_early_exit: boolean; source: string; notes: string }>(pg,
      `select is_late, is_early_exit, source, notes from attendance_records where employee_id = $1 and attendance_date = $2`, [empId, daysAgo(5)]);
    expect(a).toMatchObject({ is_late: false, is_early_exit: false, source: 'manual' });
    expect(a.notes).toMatch(/^Correction: /);
    await expect(db(mgrUser).rpc('decide_attendance_correction', { p_correction: corr, p_approve: true })).rejects.toThrow(/already been approved/);
    const notes = await db(empUser).list<{ title: string }>({ table: 'notifications', filters: [{ column: 'type', op: 'eq', value: 'attendance' }] });
    expect(notes.rows.map((n) => n.title)).toContain('Attendance correction approved');
  });

  it('employee can cancel a pending request; rejected requests leave attendance untouched', async () => {
    const d = daysAgo(3);
    const c2 = await db(empUser).rpc<string>('request_attendance_correction', { p_company: company, p_date: d, p_status: 'absent', p_check_in: null, p_check_out: null, p_reason: 'Was absent, record says present' });
    await expect(db(mateUser).rpc('cancel_attendance_correction', { p_correction: c2 })).rejects.toThrow(/not found/);
    await db(empUser).rpc('cancel_attendance_correction', { p_correction: c2 });
    const c3 = await db(empUser).rpc<string>('request_attendance_correction', { p_company: company, p_date: d, p_status: 'absent', p_check_in: null, p_check_out: null, p_reason: 'Second attempt at this' });
    await db(owner).rpc('decide_attendance_correction', { p_correction: c3, p_approve: false, p_note: 'Not supported by records' });
    expect(await sql(pg, `select 1 from attendance_records where employee_id = $1 and attendance_date = $2`, [empId, d])).toHaveLength(0);
  });

  it('HR cannot approve their own correction (self-approval blocked)', async () => {
    // make the manager an HR approver, then they request for themselves
    const [hrRole] = await sql<{ id: string }>(pg, `select id from roles where company_id = $1 and name = 'HR Manager'`, [company]);
    await sql(pg, `update company_members set role_id = $1 where company_id = $2 and user_id = $3`, [hrRole.id, company, mgrUser]);
    const d = daysAgo(2);
    const own = await db(mgrUser).rpc<string>('request_attendance_correction', { p_company: company, p_date: d, p_status: 'present', p_check_in: `${d}T09:30:00+05:30`, p_check_out: null, p_reason: 'Forgot to clock in today' });
    await expect(db(mgrUser).rpc('decide_attendance_correction', { p_correction: own, p_approve: true })).rejects.toThrow(/not allowed/);
  });
});

describe('Team leave calendar', () => {
  it('shows scoped leave without reasons: HR → company, employee → own department, never other companies', async () => {
    const mon = nextMonday();
    const [cl] = await sql<{ id: string }>(pg, `select id from leave_types where company_id = $1 and code = 'CL'`, [company]);
    await db(empUser).rpc('apply_leave', { p_company: company, p_employee: null, p_type: cl.id, p_start: mon, p_end: mon, p_half_day: false, p_reason: 'Private family matter' });
    await db(otherUser).rpc('apply_leave', { p_company: company, p_employee: null, p_type: cl.id, p_start: mon, p_end: mon, p_half_day: false, p_reason: 'Other department leave' });
    const range = { p_company: company, p_from: mon, p_to: mon };

    const hr = await db(owner).rpc<{ employee_id: string; status: string }[]>('team_leave_calendar', range);
    expect(hr.map((r) => r.employee_id).sort()).toEqual([empId, otherId].sort()); // pending visible to HR
    expect(Object.keys(hr[0])).not.toContain('reason');

    // department mate: pending requests of colleagues are hidden; approved ones appear
    expect(await db(mateUser).rpc<unknown[]>('team_leave_calendar', range)).toHaveLength(0);
    const [req] = await sql<{ id: string }>(pg, `select id from leave_requests where employee_id = $1`, [empId]);
    await db(mgrUser).rpc('decide_leave', { p_request: req.id, p_approve: true });
    const mate = await db(mateUser).rpc<{ employee_id: string }[]>('team_leave_calendar', range);
    expect(mate.map((r) => r.employee_id)).toEqual([empId]); // not the other department

    // the employee sees their own pending/approved; department filter works for HR
    expect((await db(otherUser).rpc<{ employee_id: string }[]>('team_leave_calendar', range)).map((r) => r.employee_id)).toEqual([otherId]);
    const [dept] = await sql<{ department_id: string }>(pg, `select department_id from employees where id = $1`, [otherId]);
    expect((await db(owner).rpc<{ employee_id: string }[]>('team_leave_calendar', { ...range, p_department: dept.department_id })).map((r) => r.employee_id)).toEqual([otherId]);

    await expect(db(rival).rpc('team_leave_calendar', range)).rejects.toThrow(/Not a member/);
    await expect(db(owner).rpc('team_leave_calendar', { p_company: company, p_from: '2026-01-01', p_to: '2026-12-31' })).rejects.toThrow(/3 months/);
  });
});
