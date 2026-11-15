// @vitest-environment node
// Catalog-wide tenant isolation audit: instead of a hand-picked list, enumerate EVERY public table/view,
// every storage bucket and the Realtime publication, and check them against a seeded company.
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { clientFor, createUser, migrationSql, sql } from './harness';
import { runAs, type Claims } from '@/lib/backend/local/localDb';
import { seedDemoData } from '@/lib/backend/local/seed';

let pg: PGlite;
let victim: string; // seeded demo company (Nimbus) with realistic data in every module
let attacker: string; // owner (full admin) of a different company
let attackerCompany: string;
let hasPublication = false;

/** Rows of `victim` that `claims` can see in `rel` (a permission error counts as 0 visible). */
async function visibleVictimRows(claims: Claims, rel: string): Promise<number> {
  try {
    return await runAs(pg, claims, async (tx) =>
      (await tx.query<{ n: number }>(`select count(*)::int n from public."${rel}" where company_id = $1`, [victim])).rows[0].n);
  } catch {
    return 0;
  }
}

beforeAll(async () => {
  pg = new PGlite();
  const [shim, ...migrations] = migrationSql();
  await pg.exec(shim);
  // Supabase has this publication; the local shim does not. Create it so the migrations' publication changes
  // (1100 adds chat tables, 1200 removes the ones that leaked DELETE events) are exercised and can be checked.
  try {
    await pg.exec('create publication supabase_realtime');
    hasPublication = true;
  } catch {
    hasPublication = false;
  }
  for (const m of migrations) await pg.exec(m);
  await seedDemoData(pg);
  victim = (await sql<{ id: string }>(pg, `select id from companies where slug = 'nimbus'`))[0].id;
  attacker = await createUser(pg, 'attacker@evil.test', 'Mallory Attacker');
  attackerCompany = await clientFor(pg, attacker).rpc<string>('create_company', { p_name: 'Evil Corp', p_slug: 'evil-corp' });
}, 180_000);

describe('Catalog-wide tenant isolation', () => {
  it('Row Level Security is enabled on every public table', async () => {
    const off = await sql<{ t: string }>(pg, `select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`);
    expect(off.map((r) => r.t)).toEqual([]);
  });

  it('every public view runs with the caller\'s rights (security_invoker)', async () => {
    const definer = await sql<{ v: string }>(pg, `select c.relname v from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
        and not coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on'], false) order by 1`);
    expect(definer.map((r) => r.v)).toEqual([]);
  });

  it('an admin of another company sees zero rows of the victim company in EVERY table and view with company_id', async () => {
    const rels = (await sql<{ rel: string }>(pg, `select c.relname rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') order by 1`)).map((r) => r.rel);
    expect(rels.length).toBeGreaterThan(40);
    const leaks: string[] = [];
    let withData = 0;
    for (const rel of rels) {
      const total = (await sql<{ n: number }>(pg, `select count(*)::int n from public."${rel}" where company_id = $1`, [victim]))[0].n;
      if (total > 0) withData++;
      const seen = await visibleVictimRows({ role: 'authenticated', sub: attacker, email: 'attacker@evil.test' }, rel);
      if (seen > 0) leaks.push(`${rel}: ${seen}/${total}`);
    }
    console.log(`[isolation] ${rels.length} relations with company_id checked, ${withData} hold victim data, leaks: ${leaks.length}`);
    expect(leaks).toEqual([]);
    expect(withData).toBeGreaterThan(30);
  });

  it('anonymous visitors see zero victim rows in every table and view with company_id', async () => {
    const rels = (await sql<{ rel: string }>(pg, `select c.relname rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') order by 1`)).map((r) => r.rel);
    const leaks: string[] = [];
    for (const rel of rels) {
      const seen = await visibleVictimRows({ role: 'anon' }, rel);
      if (seen > 0) leaks.push(`${rel}: ${seen}`);
    }
    expect(leaks).toEqual([]);
  });

  it('the attacker company exists and its admin can see its own data (the check above is not vacuous)', async () => {
    const own = await runAs(pg, { role: 'authenticated', sub: attacker }, async (tx) =>
      (await tx.query<{ n: number }>(`select count(*)::int n from public.roles where company_id = $1`, [attackerCompany])).rows[0].n);
    expect(own).toBeGreaterThan(0);
  });
});

describe('Storage isolation', () => {
  it('only the company-assets bucket (logos) is public', async () => {
    const pub = await sql<{ id: string }>(pg, `select id from storage.buckets where public order by 1`);
    expect(pub.map((b) => b.id)).toEqual(['company-assets']);
  });

  it('another company cannot list or read any victim object in any private bucket', async () => {
    const objs = await sql<{ bucket_id: string; name: string }>(pg,
      `select bucket_id, name from storage.objects where name like $1 || '/%' and bucket_id <> 'company-assets'`, [victim]);
    const seen = await runAs(pg, { role: 'authenticated', sub: attacker }, async (tx) =>
      (await tx.query<{ n: number }>(`select count(*)::int n from storage.objects where name like $1 || '/%' and bucket_id <> 'company-assets'`, [victim])).rows[0].n);
    console.log(`[isolation] storage: ${objs.length} private victim objects, attacker sees ${seen}`);
    expect(seen).toBe(0);
  });
});

describe('Realtime publication (after migration 1200)', () => {
  it('publishes exactly the four tables that never broadcast cross-tenant DELETE events', async () => {
    if (!hasPublication) return; // PGlite build without publication support: covered by the live test instead
    const tables = await sql<{ t: string }>(pg, `select tablename t from pg_publication_tables where pubname = 'supabase_realtime' order by 1`);
    console.log(`[isolation] realtime publication: ${tables.map((r) => r.t).join(', ')}`);
    expect(tables.map((r) => r.t)).toEqual(['chat_conversations', 'chat_messages', 'chat_typing_status', 'company_realtime_signals']);
  });

  it('typing "stop" updates the row instead of deleting it (no DELETE event)', async () => {
    const [hr] = await sql<{ id: string }>(pg, `select id from auth.users where email = 'hr@nimbus.test'`);
    const [conv] = await sql<{ conversation_id: string }>(pg, `select conversation_id from chat_participants where user_id = $1 limit 1`, [hr.id]);
    const client = clientFor(pg, hr.id);
    await client.rpc('chat_set_typing', { p_conversation: conv.conversation_id, p_typing: true });
    await client.rpc('chat_set_typing', { p_conversation: conv.conversation_id, p_typing: false });
    const rows = await sql<{ typing_at: string }>(pg, `select typing_at::text from chat_typing_status where conversation_id = $1 and user_id = $2`, [conv.conversation_id, hr.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].typing_at.startsWith('1970-01-01')).toBe(true);
  });
});
