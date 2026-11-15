// @vitest-environment node
// Verifies the demo seed runs end-to-end through the real RPCs and produces consistent data.
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { migrationSql, clientFor, sql } from './harness';
import { seedDemoData } from '@/lib/backend/local/seed';
import { deliverQueuedEmails } from '@/lib/backend/local';

describe('Demo seed', () => {
  it('seeds a realistic company through the business workflows', async () => {
    const pg = new PGlite();
    for (const s of migrationSql()) await pg.exec(s);
    await seedDemoData(pg);
    const delivered = await deliverQueuedEmails(pg);
    expect(delivered).toBeGreaterThan(10);
    const [counts] = await sql<Record<string, number>>(pg, `select
      (select count(*)::int from companies) companies, (select count(*)::int from employees) employees,
      (select count(*)::int from applications) applications, (select count(*)::int from interviews) interviews,
      (select count(*)::int from offers where status = 'sent') sent_offers, (select count(*)::int from payslips) payslips,
      (select count(*)::int from email_logs where status = 'queued') queued`);
    expect(counts).toMatchObject({ companies: 2, employees: 14, applications: 14, interviews: 6, sent_offers: 1, payslips: 14, queued: 0 });
    const [chat] = await sql<{ convs: number; msgs: number }>(pg, `select (select count(*)::int from chat_conversations) convs, (select count(*)::int from chat_messages) msgs`);
    expect(chat).toEqual({ convs: 2, msgs: 6 });
    const [hr] = await sql<{ id: string }>(pg, `select id from auth.users where email = 'hr@nimbus.test'`);
    const [co] = await sql<{ id: string }>(pg, `select id from companies where slug = 'nimbus'`);
    const stats = await clientFor(pg, hr.id).rpc<{ headcount: number; open_jobs: number }>('dashboard_stats', { p_company: co.id });
    expect(stats).toMatchObject({ headcount: 14, open_jobs: 4 });
  });
});
