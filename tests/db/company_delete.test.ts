// @vitest-environment node
// Deleting a company must remove everything with it. Migration 1200's announcement trigger used to write a realtime
// signal for the company that was being deleted, so the cascade failed with a foreign-key error and no company with
// announcements could ever be deleted (found on the live project: E2E cleanup silently left companies behind).
import { describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, sql } from './harness';

describe('company deletion', () => {
  it('cascades through announcements and their realtime signal', async () => {
    const pg = await createTestDb();
    const owner = await createUser(pg, 'owner@gone.test');
    const db = clientFor(pg, owner);
    const company = await db.rpc<string>('create_company', { p_name: 'Gone Co', p_slug: 'gone-co' });
    await db.insert('announcements', { company_id: company, title: 'Hello', body: 'First announcement' });
    expect(await sql(pg, 'select 1 from public.company_realtime_signals where company_id = $1', [company])).toHaveLength(1);

    await sql(pg, 'delete from public.companies where id = $1', [company]);

    const [left] = await sql<{ companies: number; announcements: number; signals: number }>(pg, `select
      (select count(*)::int from public.companies where id = $1) companies,
      (select count(*)::int from public.announcements where company_id = $1) announcements,
      (select count(*)::int from public.company_realtime_signals where company_id = $1) signals`, [company]);
    expect(left).toEqual({ companies: 0, announcements: 0, signals: 0 });
  }, 120_000);
});
