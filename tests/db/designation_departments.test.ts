// @vitest-environment node
// Migration 2600: designations are linked to departments so forms can show only the selected department's designations.
import { describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, sql } from './harness';

describe('designations belong to departments (migration 2600)', () => {
  it('default designations of a new company are linked; unknown titles stay general; HR can still choose', async () => {
    const pg = await createTestDb();
    const hr = await createUser(pg, 'hr@desig.test');
    const db = clientFor(pg, hr);
    const company = await db.rpc<string>('create_company', { p_name: 'Desig Co', p_slug: 'desig-co' });
    const rows = await sql<{ title: string; dept: string | null }>(pg,
      'select g.title, d.name dept from designations g left join departments d on d.id = g.department_id where g.company_id = $1 order by g.title', [company]);
    expect(Object.fromEntries(rows.map((r) => [r.title, r.dept]))).toMatchObject({
      'Software Engineer': 'Engineering', 'Senior Software Engineer': 'Engineering', 'Engineering Manager': 'Engineering',
      'HR Executive': 'Human Resources', 'Sales Executive': 'Sales', Accountant: 'Finance',
    });
    const general = await db.insert<{ id: string; department_id: string | null }>('designations', { company_id: company, title: 'Intern' });
    expect(general.department_id).toBeNull();
    const [ops] = await sql<{ id: string }>(pg, "select id from departments where company_id = $1 and name = 'Operations'", [company]);
    const chosen = await db.insert<{ department_id: string }>('designations', { company_id: company, title: 'Software Engineer II', department_id: ops.id });
    expect(chosen.department_id).toBe(ops.id);
  }, 120_000);
});
