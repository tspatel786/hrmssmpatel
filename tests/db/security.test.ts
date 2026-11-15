// @vitest-environment node
// Security tests: multi-tenant isolation, RLS, role permissions, public API
// restrictions, storage access, token expiry, integrity guards.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { anonUpload, clientFor, createTestDb, createUser, readObjectAs, sql, uploadAs } from './harness';
import { runAs } from '@/lib/backend/local/localDb';

let pg: PGlite;
let aOwner: string, bOwner: string, aRecruiter: string, aEmployeeUser: string, outsider: string;
let companyA: string, companyB: string;
let aJob: string, aEmployee: string, aDept: string, aApp: string;

const db = (u: string | null) => clientFor(pg, u);
const isoDate = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function roleId(company: string, name: string) {
  const r = await sql<{ id: string }>(pg, `select id from roles where company_id = $1 and name = $2`, [company, name]);
  return r[0].id;
}

beforeAll(async () => {
  pg = await createTestDb();
  aOwner = await createUser(pg, 'owner@a.test', 'Alice Owner');
  bOwner = await createUser(pg, 'owner@b.test', 'Bob Owner');
  aRecruiter = await createUser(pg, 'rec@a.test', 'Rita Recruiter');
  aEmployeeUser = await createUser(pg, 'emp@a.test', 'Eve Employee');
  outsider = await createUser(pg, 'nobody@x.test', 'No Body');
  companyA = await db(aOwner).rpc<string>('create_company', { p_name: 'Company A', p_slug: 'company-a' });
  companyB = await db(bOwner).rpc<string>('create_company', { p_name: 'Company B', p_slug: 'company-b' });
  await db(aOwner).rpc('invite_member', { p_company: companyA, p_email: 'rec@a.test', p_role: await roleId(companyA, 'Recruiter') });

  aDept = (await sql<{ id: string }>(pg, `select id from departments where company_id = $1 limit 1`, [companyA]))[0].id;
  const emp = await db(aOwner).insert<{ id: string }>('employees', {
    company_id: companyA, first_name: 'Eve', last_name: 'Employee', email: 'emp@a.test', department_id: aDept,
    basic_monthly: 50000, hra_monthly: 20000, allowances_monthly: 10000, joining_date: '2025-01-01',
  });
  aEmployee = emp.id;
  await db(aOwner).rpc('invite_member', { p_company: companyA, p_email: 'emp@a.test', p_role: await roleId(companyA, 'Employee'), p_employee: aEmployee });

  aJob = (await db(aOwner).insert<{ id: string }>('jobs', {
    company_id: companyA, title: 'Backend Engineer', description: 'Design APIs and data models for scale.', status: 'published',
  })).id;
  const path = `${companyA}/incoming/${crypto.randomUUID()}/cv.pdf`;
  await anonUpload(pg, 'resumes', path);
  aApp = (await db(null).rpc<{ application_id: string }>('public_submit_application', {
    p_slug: 'company-a', p_job: aJob, p_data: { first_name: 'Carl', email: 'carl@example.com', phone: '9876543210' },
    p_resume: { path, name: 'cv.pdf', size: 100 },
  })).application_id;
});

describe('Multi-tenant isolation', () => {
  const tables = ['employees', 'v_employees', 'jobs', 'candidates', 'v_applications', 'email_logs', 'audit_logs', 'roles',
    'company_members', 'departments', 'email_templates', 'leave_types', 'notifications', 'candidate_documents'];

  it.each(tables)('company B owner sees no rows of company A in %s', async (table) => {
    const res = await db(bOwner).list<{ company_id: string }>({ table, filters: [{ column: 'company_id', op: 'eq', value: companyA }] });
    expect(res.rows).toHaveLength(0);
  });

  it('company A sees its own data', async () => {
    expect((await db(aOwner).list({ table: 'v_applications', filters: [{ column: 'company_id', op: 'eq', value: companyA }] })).count).toBe(1);
  });

  it('cannot read or update another company record', async () => {
    expect(await db(bOwner).get('companies', companyA)).toBeNull();
    await expect(db(bOwner).update('companies', companyA, { name: 'Hacked' })).rejects.toThrow();
    await expect(db(bOwner).update('employees', aEmployee, { ctc_annual: 1 })).rejects.toThrow();
    await expect(db(bOwner).remove('jobs', aJob)).rejects.toThrow();
  });

  it('cannot insert data into another company', async () => {
    await expect(db(bOwner).insert('employees', { company_id: companyA, first_name: 'X', email: 'x@x.test' })).rejects.toThrow();
    await expect(db(bOwner).insert('jobs', { company_id: companyA, title: 'Fake job', description: 'This should never be inserted.' })).rejects.toThrow();
  });

  it('cannot reference another company\'s department (cross-tenant FK guard)', async () => {
    await expect(db(bOwner).insert('employees', { company_id: companyB, first_name: 'Y', email: 'y@b.test', department_id: aDept }))
      .rejects.toThrow(/does not belong/);
  });

  it('cannot call business RPCs on another company\'s records', async () => {
    await expect(db(bOwner).rpc('change_application_stage', { p_application: aApp, p_stage: 'rejected', p_reason: 'nope' }))
      .rejects.toThrow(/Permission denied/);
    await expect(db(bOwner).rpc('dashboard_stats', { p_company: companyA })).rejects.toThrow(/Permission denied/);
    await expect(db(bOwner).rpc('generate_payroll', { p_company: companyA, p_year: 2025, p_month: 1 })).rejects.toThrow(/Permission denied/);
    await expect(db(bOwner).rpc('invite_member', { p_company: companyA, p_email: 'evil@b.test', p_role: await roleId(companyA, 'Company Admin') }))
      .rejects.toThrow(/permission/);
  });

  it('a user with no membership sees nothing', async () => {
    expect((await db(outsider).list({ table: 'companies' })).count).toBe(0);
    expect((await db(outsider).list({ table: 'employees' })).count).toBe(0);
    expect(await db(outsider).rpc<unknown[]>('my_companies')).toHaveLength(0);
  });
});

describe('Role-based permissions', () => {
  it('recruiter can manage candidates but cannot see employees salary or payroll', async () => {
    expect((await db(aRecruiter).list({ table: 'v_applications', filters: [{ column: 'company_id', op: 'eq', value: companyA }] })).count).toBe(1);
    expect((await db(aRecruiter).list({ table: 'employees', filters: [{ column: 'company_id', op: 'eq', value: companyA }] })).count).toBe(0);
    await expect(db(aRecruiter).rpc('generate_payroll', { p_company: companyA, p_year: 2025, p_month: 1 })).rejects.toThrow(/payroll.manage/);
    await expect(db(aRecruiter).update('companies', companyA, { name: 'Renamed' })).rejects.toThrow();
  });

  it('employee self-service sees only their own employee record', async () => {
    const res = await db(aEmployeeUser).list<{ id: string }>({ table: 'v_employees', filters: [{ column: 'company_id', op: 'eq', value: companyA }] });
    expect(res.rows.map((r) => r.id)).toEqual([aEmployee]);
    expect((await db(aEmployeeUser).list({ table: 'candidates' })).count).toBe(0);
    expect((await db(aEmployeeUser).list({ table: 'email_logs' })).count).toBe(0);
    await expect(db(aEmployeeUser).update('employees', aEmployee, { ctc_annual: 99999999 })).rejects.toThrow();
  });

  it('company admin cannot change plan, status or limits; super admin can', async () => {
    await expect(db(aOwner).update('companies', companyA, { plan: 'enterprise' })).rejects.toThrow(/platform administrator/);
    await expect(db(aOwner).update('companies', companyA, { max_employees: 100000 })).rejects.toThrow(/platform administrator/);
    const admin = await createUser(pg, 'root@platform.test', 'Root');
    await pg.query(`insert into platform_admins (user_id) values ($1)`, [admin]);
    await db(admin).rpc('admin_update_company', { p_company: companyA, p_status: 'active', p_plan: 'growth', p_max_employees: 200 });
    expect((await db(admin).list({ table: 'v_admin_companies' })).count).toBe(2);
    expect((await db(aOwner).list({ table: 'v_admin_companies' })).count).toBe(0);
    await expect(db(aOwner).rpc('admin_platform_stats')).rejects.toThrow(/Platform administrator/);
  });

  it('protects the last company admin and system roles', async () => {
    const [m] = await sql<{ id: string }>(pg, `select id from company_members where company_id = $1 and user_id = $2`, [companyA, aOwner]);
    await expect(db(aOwner).update('company_members', m.id, { role_id: await roleId(companyA, 'Employee') })).rejects.toThrow(/own role/);
    await expect(db(aOwner).remove('roles', await roleId(companyA, 'HR Manager'))).rejects.toThrow(/System roles/);
    await expect(db(aOwner).insert('role_permissions', { role_id: await roleId(companyA, 'Company Admin'), permission: 'audit.view' }))
      .rejects.toThrow(/always has every permission/);
  });

  it('suspended companies lose access', async () => {
    await pg.query(`update companies set status = 'suspended' where id = $1`, [companyB]);
    expect((await db(bOwner).list({ table: 'departments', filters: [{ column: 'company_id', op: 'eq', value: companyB }] })).count).toBe(0);
    await pg.query(`update companies set status = 'active' where id = $1`, [companyB]);
  });
});

describe('Public API restrictions (anonymous)', () => {
  it('anon cannot read tables directly', async () => {
    for (const t of ['companies', 'jobs', 'candidates', 'employees', 'email_logs']) {
      await expect(db(null).list({ table: t })).rejects.toThrow(/permission/i);
    }
  });

  it('anon cannot call internal or staff RPCs', async () => {
    await expect(db(null).rpc('enqueue_email', { p_company: companyA, p_template: 'x', p_to_email: 'a@b.c', p_to_name: '', p_vars: {}, p_dedupe_key: 'x' }))
      .rejects.toThrow();
    await expect(db(null).rpc('create_company', { p_name: 'Anon Inc', p_slug: 'anon-inc' })).rejects.toThrow(/Authentication required/);
    await expect(db(null).rpc('change_application_stage', { p_application: aApp, p_stage: 'shortlisted' })).rejects.toThrow();
  });

  it('draft/closed jobs are not exposed publicly', async () => {
    const draft = await db(aOwner).insert<{ id: string }>('jobs', { company_id: companyA, title: 'Secret Role', description: 'Not yet public at all.', status: 'draft' });
    expect((await db(null).rpc<{ id: string }[]>('public_jobs', { p_slug: 'company-a' })).map((j) => j.id)).not.toContain(draft.id);
    expect(await db(null).rpc('public_job', { p_slug: 'company-a', p_job: draft.id })).toBeNull();
    const path = `${companyA}/incoming/${crypto.randomUUID()}/cv.pdf`;
    await anonUpload(pg, 'resumes', path);
    await expect(db(null).rpc('public_submit_application', {
      p_slug: 'company-a', p_job: draft.id, p_data: { first_name: 'Z', email: 'z@example.com', phone: '9876543210' }, p_resume: { path },
    })).rejects.toThrow(/no longer accepting/);
  });

  it('validates input on public applications', async () => {
    const path = `${companyA}/incoming/${crypto.randomUUID()}/cv.pdf`;
    await anonUpload(pg, 'resumes', path);
    const base = { p_slug: 'company-a', p_job: aJob, p_resume: { path } };
    await expect(db(null).rpc('public_submit_application', { ...base, p_data: { first_name: 'A', email: 'not-an-email', phone: '9876543210' } }))
      .rejects.toThrow(/valid email/);
    await expect(db(null).rpc('public_submit_application', { ...base, p_data: { first_name: '', email: 'a@example.com', phone: '9876543210' } }))
      .rejects.toThrow(/First name/);
    await expect(db(null).rpc('public_submit_application', { ...base, p_data: { first_name: 'A', email: 'a@example.com', phone: 'abc' } }))
      .rejects.toThrow(/phone/);
    // resume path outside the company incoming folder is rejected
    await expect(db(null).rpc('public_submit_application', {
      ...base, p_resume: { path: `${companyB}/incoming/x/cv.pdf` }, p_data: { first_name: 'A', email: 'a@example.com', phone: '9876543210' },
    })).rejects.toThrow(/Invalid resume/);
  });

  it('rate-limits repeated public applications per email', async () => {
    const jobs: string[] = [];
    for (let i = 0; i < 6; i++) {
      jobs.push((await db(aOwner).insert<{ id: string }>('jobs', {
        company_id: companyA, title: `Role number ${i}`, description: 'Rate limit test position description.', status: 'published',
      })).id);
    }
    let error: Error | null = null;
    for (const j of jobs) {
      const path = `${companyA}/incoming/${crypto.randomUUID()}/cv.pdf`;
      await anonUpload(pg, 'resumes', path);
      try {
        await db(null).rpc('public_submit_application', {
          p_slug: 'company-a', p_job: j, p_data: { first_name: 'Spam', email: 'spam@example.com', phone: '9876543210' }, p_resume: { path },
        });
      } catch (e) { error = e as Error; break; }
    }
    expect(error?.message).toMatch(/Too many submissions/);
  });
});

describe('Document storage access', () => {
  it('anon can upload only into an existing company incoming folder and cannot read resumes', async () => {
    const ok = `${companyA}/incoming/${crypto.randomUUID()}/cv.pdf`;
    await anonUpload(pg, 'resumes', ok);
    expect(await readObjectAs(pg, null, 'resumes', ok)).toBe(false);
    await expect(anonUpload(pg, 'resumes', `${companyA}/candidates/x/cv.pdf`)).rejects.toThrow();
    await expect(anonUpload(pg, 'resumes', `${crypto.randomUUID()}/incoming/${crypto.randomUUID()}/cv.pdf`)).rejects.toThrow();
    await expect(anonUpload(pg, 'documents', `${companyA}/offers/x.pdf`)).rejects.toThrow();
  });

  it('recruiters of the same company can read resumes; other companies cannot', async () => {
    const [doc] = await sql<{ storage_path: string }>(pg, `select storage_path from candidate_documents where company_id = $1 limit 1`, [companyA]);
    expect(await readObjectAs(pg, aRecruiter, 'resumes', doc.storage_path)).toBe(true);
    expect(await readObjectAs(pg, bOwner, 'resumes', doc.storage_path)).toBe(false);
    expect(await readObjectAs(pg, aEmployeeUser, 'resumes', doc.storage_path)).toBe(false);
  });

  it('employees can read only their own documents folder', async () => {
    const own = `${companyA}/employees/${aEmployee}/id-proof.pdf`;
    await uploadAs(pg, aOwner, 'documents', own);
    expect(await readObjectAs(pg, aEmployeeUser, 'documents', own)).toBe(true);
    expect(await readObjectAs(pg, bOwner, 'documents', own)).toBe(false);
    await expect(uploadAs(pg, aEmployeeUser, 'documents', `${companyA}/offers/fake.pdf`)).rejects.toThrow();
  });
});

describe('Offer token security', () => {
  it('expired tokens cannot be used and the offer is marked expired', async () => {
    const owner = db(aOwner);
    // move candidate to selected
    await owner.rpc('change_application_stage', { p_application: aApp, p_stage: 'selected' });
    const offer = await owner.insert<{ id: string }>('offers', {
      company_id: companyA, application_id: aApp, ctc_annual: 900000, joining_date: isoDate(30), expiry_date: isoDate(3),
    });
    await owner.rpc('submit_offer_for_approval', { p_offer: offer.id });
    await owner.rpc('decide_offer', { p_offer: offer.id, p_approve: true });
    const pdf = `${companyA}/offers/${offer.id}.pdf`;
    await uploadAs(pg, aOwner, 'documents', pdf);
    const { offer_link } = await owner.rpc<{ offer_link: string }>('send_offer', { p_offer: offer.id, p_base_url: 'https://hr.example.com', p_pdf_path: pdf });
    const token = offer_link.split('/').pop()!;
    // simulate time passing beyond expiry
    await pg.query(`update offers set token_expires_at = now() - interval '1 minute' where id = $1`, [offer.id]);
    await expect(db(null).rpc('public_respond_offer', { p_token: token, p_accept: true, p_signature: 'Carl' })).rejects.toThrow(/expired/);
    const view = await db(null).rpc<{ status: string }>('public_get_offer', { p_token: token });
    expect(view.status).toBe('expired');
    await expect(db(null).rpc('public_get_offer', { p_token: 'not-a-token' })).rejects.toThrow(/Invalid/);
  });

  it('token hash is never written to the audit trail', async () => {
    const rows = await sql(pg, `select 1 from audit_logs where table_name = 'offers' and (new_data ? 'token_hash' or old_data ? 'token_hash')`);
    expect(rows).toHaveLength(0);
  });
});

describe('Requisition approval rules', () => {
  it('requester cannot self-approve unless admin; approvals record approver', async () => {
    const rec = db(aRecruiter);
    const r = await rec.insert<{ id: string; requested_by: string }>('job_requisitions', {
      company_id: companyA, title: 'QA Engineer', justification: 'Release quality needs a dedicated tester.', status: 'pending_approval',
    });
    expect(r.requested_by).toBe(aRecruiter);
    await expect(rec.update('job_requisitions', r.id, { status: 'approved' })).rejects.toThrow(/permission to approve/);
    const approved = await db(aOwner).update<{ approved_by: string }>('job_requisitions', r.id, { status: 'approved' });
    expect(approved.approved_by).toBe(aOwner);
  });
});

describe('Service role isolation in the local runtime', () => {
  it('runAs applies roles per transaction (no leakage between calls)', async () => {
    const who = await runAs(pg, { role: 'anon' }, async (tx) => (await tx.query<{ u: string }>('select current_user as u')).rows[0].u);
    expect(who).toBe('anon');
    const after = (await pg.query<{ u: string }>('select current_user as u')).rows[0].u;
    expect(after).toBe('postgres');
  });
});
