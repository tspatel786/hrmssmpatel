// @vitest-environment node
// Locks the default role → permission matrix to what the User Guide and feature guide document.
// If a role's permissions change on purpose, update this test AND the docs together.
import { describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, sql } from './harness';

const EXPECTED: Record<string, string[]> = {
  Recruiter: ['candidates.manage', 'candidates.view', 'dashboard.view', 'departments.view', 'emails.manage', 'interviews.manage', 'interviews.view',
    'jobs.manage', 'jobs.view', 'offers.manage', 'offers.view', 'onboarding.manage', 'onboarding.view', 'reports.view', 'requisitions.manage', 'requisitions.view'],
  // requisitions.approve added by migration 1500 (managers approve hiring requests; self-approval stays blocked)
  'Hiring Manager': ['candidates.view', 'dashboard.view', 'departments.view', 'employees.view', 'interviews.view', 'jobs.view', 'leave.approve',
    'offers.approve', 'offers.view', 'reports.view', 'requisitions.approve', 'requisitions.manage', 'requisitions.view'],
  'Payroll Manager': ['attendance.view', 'dashboard.view', 'departments.view', 'employees.view', 'leave.view', 'payroll.manage', 'payroll.view', 'reports.view'],
  // Interviewer and Employee hold no company-wide permission: access comes from ownership rules (own records, assigned interviews)
  Interviewer: [],
  Employee: [],
};

describe('Default role permission matrix', () => {
  it('matches the documented matrix for every built-in role', async () => {
    const pg = await createTestDb();
    const owner = await createUser(pg, 'owner@matrix.test');
    const co = await clientFor(pg, owner).rpc<string>('create_company', { p_name: 'Matrix Company', p_slug: 'matrix-co' });
    const all = (await sql<{ key: string }>(pg, `select key from permissions order by key`)).map((r) => r.key);
    expect(all).toHaveLength(32);
    const roles = await sql<{ name: string; is_admin: boolean; is_system: boolean; perms: string[] }>(pg,
      `select r.name, r.is_admin, r.is_system,
              coalesce(array_agg(rp.permission order by rp.permission) filter (where rp.permission is not null), '{}') perms
       from roles r left join role_permissions rp on rp.role_id = r.id where r.company_id = $1
       group by r.name, r.is_admin, r.is_system order by r.name`, [co]);
    const byName = Object.fromEntries(roles.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual(['Company Admin', 'Employee', 'HR Manager', 'Hiring Manager', 'Interviewer', 'Payroll Manager', 'Recruiter']);
    expect(roles.every((r) => r.is_system)).toBe(true);
    // Company Admin is the only admin role (implicitly every permission)
    expect(roles.filter((r) => r.is_admin).map((r) => r.name)).toEqual(['Company Admin']);
    // HR Manager: everything except company settings and user management
    expect(byName['HR Manager'].perms).toEqual(all.filter((p) => p !== 'settings.manage' && p !== 'users.manage'));
    for (const [name, perms] of Object.entries(EXPECTED)) expect(byName[name].perms, name).toEqual([...perms].sort());
  }, 120_000);
});
