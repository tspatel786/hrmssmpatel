// Applies the local shim + all migrations to a fresh in-memory PGlite and reports errors.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
const db = new PGlite();
const files = [path.join('supabase/local/shim.sql'),
  ...fs.readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort().map(f => path.join('supabase/migrations', f))];
for (const f of files) {
  try { await db.exec(fs.readFileSync(f, 'utf8')); console.log('OK  ', f); }
  catch (e) { console.error('FAIL', f, '\n', e.message, e.position ? `@${e.position}` : '', e.where || ''); process.exit(1); }
}
const t = await db.query(`select count(*)::int n from pg_tables where schemaname='public'`);
const v = await db.query(`select count(*)::int n from pg_views where schemaname='public'`);
const f = await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`);
const p = await db.query(`select count(*)::int n from pg_policies`);
console.log({ tables: t.rows[0].n, views: v.rows[0].n, functions: f.rows[0].n, policies: p.rows[0].n });
