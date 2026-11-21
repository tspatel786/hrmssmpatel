// @vitest-environment node
// Migration 1700: platform_settings.public_signup switches between the SaaS product (anyone creates a company)
// and an internal HRMS (invitation only; platform admins still create companies).
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { clientFor, createTestDb, createUser, sql } from './harness';

describe('public sign-up switch (migration 1700)', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await createTestDb();
  }, 120_000);

  it('is open by default, so existing deployments behave as before', async () => {
    const u = await createUser(pg, 'founder@open.test');
    expect(await clientFor(pg, null).rpc<boolean>('public_signup_enabled', {})).toBe(true); // anonymous visitors can read it
    const id = await clientFor(pg, u).rpc<string>('create_company', { p_name: 'Open Co', p_slug: 'open-co' });
    expect(id).toBeTruthy();
  });

  it('when closed, an ordinary account cannot create a company', async () => {
    await sql(pg, 'update public.platform_settings set public_signup = false');
    const u = await createUser(pg, 'stranger@closed.test');
    expect(await clientFor(pg, u).rpc<boolean>('public_signup_enabled', {})).toBe(false);
    await expect(clientFor(pg, u).rpc('create_company', { p_name: 'Sneaky Co', p_slug: 'sneaky-co' })).rejects.toThrow(/invite you/);
    expect(await sql(pg, `select 1 from public.companies where slug = 'sneaky-co'`)).toHaveLength(0);
  });

  it('when closed, a platform admin can still create a company', async () => {
    const admin = await createUser(pg, 'owner@closed.test');
    await sql(pg, 'insert into public.platform_admins (user_id) values ($1)', [admin]);
    expect(await clientFor(pg, admin).rpc<string>('create_company', { p_name: 'Second Branch', p_slug: 'second-branch' })).toBeTruthy();
  });

  it('end users cannot read or flip the setting directly', async () => {
    const u = await createUser(pg, 'tamper@closed.test');
    const db = clientFor(pg, u);
    await expect(db.list({ table: 'platform_settings' })).rejects.toThrow();
    await expect(db.update('platform_settings', 'true', { public_signup: true })).rejects.toThrow();
    expect((await sql<{ public_signup: boolean }>(pg, 'select public_signup from public.platform_settings'))[0].public_signup).toBe(false);
  });
});
