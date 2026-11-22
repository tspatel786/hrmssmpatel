// @vitest-environment node
// Hand-offs between workflows (hire -> attendance -> leave -> payroll -> exit) that the single-module tests do not cover.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { anonUpload, clientFor, createTestDb, createUser, serviceClient, sql, verifyJoiningDocuments } from './harness';

let pg: PGlite;
const ids: Record<string, string> = {};
const as = (u: string) => clientFor(pg, ids[u]);
const svc = () => serviceClient(pg);
let today = '';
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (iso: string, dir: 1 | -1) => { let d = iso; while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, dir); return d; };

async function employee(key: string, extra: Record<string, unknown> = {}) {
  const email = `${key}@gap.test`;
  ids[`${key}Emp`] = (await as('hr').insert<{ id: string }>('employees', {
    company_id: ids.company, first_name: key, last_name: 'Test', email, joining_date: addDays(today, -400),
    basic_monthly: 30000, hra_monthly: 12000, allowances_monthly: 3000, ...extra,
  })).id;
  await as('hr').rpc('send_employee_login', { p_employee: ids[`${key}Emp`] });
  const [{ token }] = await sql<{ token: string }>(pg, 'select token from employee_activations where employee_id = $1', [ids[`${key}Emp`]]);
  ids[key] = await createUser(pg, email);
  await svc().rpc('consume_employee_activation', { p_token: token, p_user: ids[key] });
}
async function exitEmployee(key: string, lastDay: string) {
  const r = await as(key).rpc<string>('submit_resignation', { p_company: ids.company, p_reason: 'Moving on to a new opportunity', p_last_day: addDays(today, 1) });
  const [{ status }] = await sql<{ status: string }>(pg, 'select status from resignations where id = $1', [r]);
  if (status === 'pending_manager') await as('lead').rpc('decide_resignation_manager', { p_resignation: r, p_approve: true });
  await as('hr').rpc('decide_resignation_hr', { p_resignation: r, p_approve: true, p_last_day: addDays(today, 1) });
  const tasks = await as('hr').list<{ id: string }>({ table: 'exit_tasks', filters: [{ column: 'resignation_id', op: 'eq', value: r }] });
  for (const t of tasks.rows) await as('hr').update('exit_tasks', t.id, { is_completed: true });
  await as('hr').rpc('set_exit_settlement', { p_resignation: r, p_status: 'paid' });
  await as('hr').rpc('complete_exit', { p_resignation: r });
  await sql(pg, 'update resignations set approved_last_day = $2 where id = $1', [r, lastDay]);
  await sql(pg, 'update employees set exit_date = $2 where id = $1', [ids[`${key}Emp`], lastDay]);
  await sql(pg, 'delete from daily_job_runs');
  await svc().rpc('run_daily_jobs');
  return r;
}

describe('workflow hand-off gaps', () => {
  beforeAll(async () => {
    pg = await createTestDb();
    ids.hr = await createUser(pg, 'hr@gap.test');
    ids.company = await as('hr').rpc<string>('create_company', { p_name: 'Gap Co', p_slug: 'gap-co' });
    [{ today }] = await sql<{ today: string }>(pg, "select to_char((now() at time zone public.company_tz($1))::date, 'YYYY-MM-DD') today", [ids.company]);
    await employee('lead');
    await employee('dev', { manager_id: ids.leadEmp });
    await employee('qa', { manager_id: ids.leadEmp });
  }, 180_000);

  it('G1 go-live: staff added today with an old joining date are not marked absent for days before they were added', async () => {
    await sql(pg, 'delete from daily_job_runs');
    await svc().rpc('run_daily_jobs');
    const [{ n }] = await sql<{ n: number }>(pg, "select count(*)::int n from attendance_records where company_id = $1 and status = 'absent'", [ids.company]);
    expect(n).toBe(0);
  });

  it('G2 a holiday added afterwards removes the automatic absence on that day', async () => {
    const day = weekday(addDays(today, -3), -1);
    await sql(pg, "insert into attendance_records (company_id, employee_id, attendance_date, status, source) values ($1, $2, $3, 'absent', 'system') on conflict (employee_id, attendance_date) do update set status = 'absent', source = 'system', check_in = null, check_out = null", [ids.company, ids.qaEmp, day]);
    await as('hr').insert('holidays', { company_id: ids.company, name: 'Local festival', holiday_date: day });
    expect(await sql(pg, 'select 1 from attendance_records where employee_id = $1 and attendance_date = $2', [ids.qaEmp, day])).toHaveLength(0);
  });

  it('G3 notice period: leave cannot extend past the approved last working day', async () => {
    const r = await as('qa').rpc<string>('submit_resignation', { p_company: ids.company, p_reason: 'Relocating with my family soon', p_last_day: addDays(today, 20) });
    await as('lead').rpc('decide_resignation_manager', { p_resignation: r, p_approve: true });
    await as('hr').rpc('decide_resignation_hr', { p_resignation: r, p_approve: true, p_last_day: addDays(today, 20) });
    const [lt] = await sql<{ id: string }>(pg, "select id from leave_types where company_id = $1 and code = 'CL'", [ids.company]);
    const start = weekday(addDays(today, 21), 1);
    await expect(as('qa').rpc('apply_leave', { p_company: ids.company, p_employee: ids.qaEmp, p_type: lt.id, p_start: start, p_end: start, p_half_day: false, p_reason: 'After last day' }))
      .rejects.toThrow(/last working day/);
    await as('qa').rpc('withdraw_resignation', { p_resignation: r, p_reason: 'Staying after all' });
    await as('hr').rpc('decide_resignation_withdrawal', { p_resignation: r, p_approve: true });
  });

  it('G4 a manager who resigns gets a "reassign direct reports" checklist item', async () => {
    const r = await as('lead').rpc<string>('submit_resignation', { p_company: ids.company, p_reason: 'Starting my own business venture', p_last_day: addDays(today, 30) });
    await as('hr').rpc('decide_resignation_hr', { p_resignation: r, p_approve: true });
    const tasks = await as('hr').list<{ title: string }>({ table: 'exit_tasks', filters: [{ column: 'resignation_id', op: 'eq', value: r }] });
    expect(tasks.rows.map((t) => t.title).join(' | ')).toMatch(/Reassign 2 direct report/);
    await as('lead').rpc('withdraw_resignation', { p_resignation: r, p_reason: 'Plans changed' });
    await as('hr').rpc('decide_resignation_withdrawal', { p_resignation: r, p_approve: true });
  });

  it('G5 exit: pending requests are closed and the leaver still gets the final month payslip', async () => {
    const [lt] = await sql<{ id: string }>(pg, "select id from leave_types where company_id = $1 and code = 'CL'", [ids.company]);
    const lday = weekday(addDays(today, 1), 1);
    await as('dev').rpc('apply_leave', { p_company: ids.company, p_employee: ids.devEmp, p_type: lt.id, p_start: lday, p_end: lday, p_half_day: false, p_reason: 'Pending at exit' });
    // last working day earlier this month (or yesterday on the 1st) so the payroll month contains it
    const monthStart = `${today.slice(0, 8)}01`;
    const last = today === monthStart ? addDays(today, -1) : addDays(today, -1);
    await exitEmployee('dev', last);
    const [e] = await sql<{ status: string }>(pg, 'select status from employees where id = $1', [ids.devEmp]);
    expect(e.status).toBe('inactive');
    expect(await sql(pg, "select 1 from leave_requests where employee_id = $1 and status = 'pending'", [ids.devEmp])).toHaveLength(0);
    const [y, m] = last.split('-').map(Number);
    await sql(pg, 'delete from payroll_runs where company_id = $1 and period_year = $2 and period_month = $3', [ids.company, y, m]);
    await as('hr').rpc('generate_payroll', { p_company: ids.company, p_year: y, p_month: m });
    expect(await sql(pg, 'select 1 from payslips where employee_id = $1', [ids.devEmp])).toHaveLength(1);
  });

  it('G6 internal transfer: an employee hired through an internal application keeps their record and Employee ID', async () => {
    const job = await as('hr').insert<{ id: string }>('jobs', { company_id: ids.company, title: 'QA Lead', location: 'Office', description: 'Lead the quality assurance team.', status: 'published' });
    const app = await as('qa').rpc<string>('internal_apply', { p_job: job.id, p_note: 'I would like to lead QA.' });
    for (const s of ['screening', 'shortlisted', 'selected']) await as('hr').rpc('change_application_stage', { p_application: app, p_stage: s });
    const [cand] = await sql<{ candidate_id: string }>(pg, 'select candidate_id from applications where id = $1', [app]);
    const offer = await as('hr').insert<{ id: string }>('offers', {
      company_id: ids.company, application_id: app, candidate_id: cand.candidate_id, job_id: job.id, ctc_annual: 900000,
      basic_monthly: 40000, hra_monthly: 16000, allowances_monthly: 19000, joining_date: weekday(addDays(today, 3), 1), expiry_date: addDays(today, 7), status: 'draft',
    });
    if ((await as('hr').rpc<string>('submit_offer_for_approval', { p_offer: offer.id })) !== 'approved') {
      await as('lead').rpc('decide_offer', { p_offer: offer.id, p_approve: true }).catch(() => as('hr').rpc('decide_offer', { p_offer: offer.id, p_approve: true }));
    }
    const path = `${ids.company}/offers/${offer.id}.pdf`;
    await anonUpload(pg, 'documents', path).catch(() => undefined);
    const sent = await as('hr').rpc<{ offer_link: string }>('send_offer', { p_offer: offer.id, p_base_url: 'http://x', p_pdf_path: path });
    await clientFor(pg, null).rpc('public_respond_offer', { p_token: sent.offer_link.split('/').pop(), p_accept: true, p_signature: 'qa Test' });
    const [onb] = await sql<{ id: string }>(pg, 'select id from onboardings where offer_id = $1', [offer.id]);
    await as('hr').rpc('confirm_joining', { p_onboarding: onb.id, p_joining_date: weekday(addDays(today, 3), 1) });
    await verifyJoiningDocuments(pg, ids.hr, onb.id);
    const emp = await as('hr').rpc<string>('complete_onboarding', { p_onboarding: onb.id });
    expect(emp).toBe(ids.qaEmp);
    const [e] = await sql<{ employee_code: string; ctc_annual: number; basic_monthly: number }>(pg, 'select employee_code, ctc_annual::float, basic_monthly::float from employees where id = $1', [ids.qaEmp]);
    expect(e).toMatchObject({ ctc_annual: 900000, basic_monthly: 40000 });
    expect(await sql(pg, "select 1 from employees where company_id = $1 and lower(email) = 'qa@gap.test'", [ids.company])).toHaveLength(1);
  });

  it('G7 probation: reminder 7 days before the end; HR confirms or extends', async () => {
    const e = await as('hr').insert<{ id: string }>('employees', {
      company_id: ids.company, first_name: 'Prob', last_name: 'Ation', email: 'prob@gap.test', joining_date: addDays(today, -173),
      status: 'probation', probation_end_date: addDays(today, 7),
    });
    await sql(pg, 'delete from daily_job_runs');
    await svc().rpc('run_daily_jobs');
    expect((await sql<{ title: string }>(pg, 'select title from notifications where user_id = $1', [ids.hr])).map((n) => n.title).join(' | ')).toMatch(/Probation ends on .*: Prob Ation/);
    await expect(as('hr').rpc('decide_probation', { p_employee: e.id, p_confirm: false, p_extend_to: addDays(today, 3) })).rejects.toThrow(/after the current/);
    await as('hr').rpc('decide_probation', { p_employee: e.id, p_confirm: false, p_extend_to: addDays(today, 60) });
    await as('hr').rpc('decide_probation', { p_employee: e.id, p_confirm: true, p_note: 'Great first months' });
    const [row] = await sql<{ status: string }>(pg, 'select status from employees where id = $1', [e.id]);
    expect(row.status).toBe('active');
    await expect(as('hr').rpc('decide_probation', { p_employee: e.id, p_confirm: true })).rejects.toThrow(/not on probation/);
  });

  it('G8 leave balances appear automatically: new employees pro-rated, next year allocated with carry-forward', async () => {
    const year = Number(today.slice(0, 4));
    const e = await as('hr').insert<{ id: string }>('employees', {
      company_id: ids.company, first_name: 'New', last_name: 'Joiner', email: 'newjoiner@gap.test', joining_date: `${year}-07-01`,
    });
    const bal = await sql<{ code: string; allocated: number }>(pg,
      'select t.code, b.allocated::float allocated from leave_balances b join leave_types t on t.id = b.leave_type_id where b.employee_id = $1 and b.year = $2 order by t.code', [e.id, year]);
    expect(bal.find((b) => b.code === 'CL')?.allocated).toBe(6); // 12 days x 6/12 months
    expect(bal.find((b) => b.code === 'LOP')).toBeUndefined(); // unpaid types get no balance
    // next year: the daily job allocates with carry-forward (EL carries forward by default)
    const [el] = await sql<{ id: string; carry_forward: boolean }>(pg, "select id, carry_forward from leave_types where company_id = $1 and code = 'EL'", [ids.company]);
    await sql(pg, 'update leave_balances set used = 2 where employee_id = $1 and leave_type_id = $2 and year = $3', [e.id, el.id, year]);
    await svc().rpc('allocate_year_balances', { p_company: ids.company, p_year: year + 1 }).catch(async () => {
      await sql(pg, 'select public.allocate_year_balances($1, $2)', [ids.company, year + 1]);
    });
    const [next] = await sql<{ allocated: number }>(pg, 'select allocated::float allocated from leave_balances where employee_id = $1 and leave_type_id = $2 and year = $3', [e.id, el.id, year + 1]);
    const [prev] = await sql<{ allocated: number }>(pg, 'select allocated::float allocated from leave_balances where employee_id = $1 and leave_type_id = $2 and year = $3', [e.id, el.id, year]);
    const [quota] = await sql<{ q: number }>(pg, 'select annual_quota::float q from leave_types where id = $1', [el.id]);
    expect(next.allocated).toBe(quota.q + (el.carry_forward ? prev.allocated - 2 : 0));
    await expect(as('hr').rpc('allocate_year_balances', { p_company: ids.company, p_year: year + 1 })).rejects.toThrow();
  });

  it('G9 time-based: expired offers, missed clock-out, stale leave, missing joining documents, unused login links', async () => {
    const titles = async (u: string) => (await sql<{ title: string }>(pg, 'select title from notifications where user_id = $1', [u])).map((n) => n.title).join(' | ');
    // missed clock-out yesterday (yesterday may be a weekend: the job only looks at the record)
    await employee('late');
    await sql(pg, "insert into attendance_records (company_id, employee_id, attendance_date, check_in, status, source) values ($1, $2, $3, now() - interval '30 hours', 'present', 'self') on conflict (employee_id, attendance_date) do update set check_in = excluded.check_in, check_out = null, status = 'present'",
      [ids.company, ids.lateEmp, addDays(today, -1)]);
    // leave pending for 2 days with the employee's manager
    await sql(pg, 'update employees set manager_id = $2 where id = $1', [ids.lateEmp, ids.leadEmp]);
    const [lt] = await sql<{ id: string }>(pg, "select id from leave_types where company_id = $1 and code = 'CL'", [ids.company]);
    const lday = weekday(addDays(today, 10), 1);
    const req = await as('late').rpc<string>('apply_leave', { p_company: ids.company, p_employee: ids.lateEmp, p_type: lt.id, p_start: lday, p_end: lday, p_half_day: false, p_reason: 'Family event' });
    await sql(pg, "update leave_requests set created_at = now() - interval '2 days' where id = $1", [req]);
    // unused login link that expired yesterday
    const e = await as('hr').insert<{ id: string }>('employees', { company_id: ids.company, first_name: 'Never', last_name: 'Activated', email: 'never@gap.test', joining_date: addDays(today, -30) });
    await as('hr').rpc('send_employee_login', { p_employee: e.id });
    await sql(pg, "update employee_activations set expires_at = now() - interval '1 day' where employee_id = $1", [e.id]);

    await sql(pg, 'delete from daily_job_runs');
    await svc().rpc('run_daily_jobs');
    expect(await titles(ids.late)).toMatch(/You did not clock out on/);
    expect(await titles(ids.lead)).toMatch(/Reminder: leave request from late Test/);
    expect(await titles(ids.hr)).toMatch(/Login link expired: Never Activated/);
    // once per day only
    await svc().rpc('run_daily_jobs');
    const [{ n }] = await sql<{ n: number }>(pg, "select count(*)::int n from notifications where user_id = $1 and title like 'You did not clock out%'", [ids.late]);
    expect(n).toBe(1);
  });

  it('G10 an offer past its expiry date is marked expired by the daily job', async () => {
    const [o] = await sql<{ id: string }>(pg, "select id from offers where company_id = $1 limit 1", [ids.company]);
    await pg.exec(`begin; select set_config('hrms.offer_rpc', 'on', true); update offers set status = 'sent', token_expires_at = now() - interval '1 hour' where id = '${o.id}'; commit;`);
    await sql(pg, 'delete from daily_job_runs');
    await svc().rpc('run_daily_jobs');
    const [after] = await sql<{ status: string }>(pg, 'select status from offers where id = $1', [o.id]);
    expect(after.status).toBe('expired');
  });

  it('G11 terminating or deleting an employee closes their login; reactivating reopens it; last admin is protected', async () => {
    await employee('term');
    const member = async () => (await sql<{ status: string }>(pg, 'select status from company_members where company_id = $1 and user_id = $2', [ids.company, ids.term]))[0]?.status;
    await as('hr').update('employees', ids.termEmp, { status: 'terminated' });
    expect(await member()).toBe('inactive');
    await expect(as('term').rpc('my_dashboard', { p_company: ids.company })).rejects.toThrow();
    await as('hr').update('employees', ids.termEmp, { status: 'active' });
    expect(await member()).toBe('active');
    await as('hr').remove('employees', ids.termEmp);
    expect(await member()).toBe('inactive');
    // the only Company Admin cannot lock themselves out through their employee record
    const me = await as('hr').insert<{ id: string }>('employees', { company_id: ids.company, first_name: 'Admin', last_name: 'Self', email: 'hr@gap.test', joining_date: addDays(today, -100) });
    await sql(pg, 'update company_members set employee_id = $1 where company_id = $2 and user_id = $3', [me.id, ids.company, ids.hr]);
    await expect(as('hr').update('employees', me.id, { status: 'terminated' })).rejects.toThrow(/only active Company Admin/);
  });

  it('G12 employees update their own contact details (not bank/salary); HR is notified', async () => {
    await employee('self');
    await as('self').rpc('update_my_details', { p_company: ids.company, p_details: { phone: '+91 98765 43210', address: 'Plot 4, Station Road', city: 'Solapur', emergency_contact_name: 'Asha', emergency_contact_phone: '9000000009', marital_status: 'married' } });
    const [e] = await sql<{ phone: string; city: string; emergency_contact_name: string; marital_status: string }>(pg, 'select phone, city, emergency_contact_name, marital_status from employees where id = $1', [ids.selfEmp]);
    expect(e).toEqual({ phone: '+91 98765 43210', city: 'Solapur', emergency_contact_name: 'Asha', marital_status: 'married' });
    await expect(as('self').rpc('update_my_details', { p_company: ids.company, p_details: { phone: 'call me' } })).rejects.toThrow(/valid phone/);
    await expect(as('self').update('employees', ids.selfEmp, { bank_account_number: '999' })).rejects.toThrow();
    expect((await sql<{ title: string }>(pg, 'select title from notifications where user_id = $1', [ids.hr])).map((n) => n.title)).toContain('Details updated by self Test');
  });
});
