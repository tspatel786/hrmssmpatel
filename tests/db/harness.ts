// Test harness: fresh PGlite database with the Supabase shim + all real migrations.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { LocalDb, runAs, type Claims } from '@/lib/backend/local/localDb';

const root = path.resolve(__dirname, '../..');
export function migrationSql(): string[] {
  const dir = path.join(root, 'supabase/migrations');
  return [
    fs.readFileSync(path.join(root, 'supabase/local/shim.sql'), 'utf8'),
    ...fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')),
  ];
}

export async function createTestDb() {
  const pg = new PGlite();
  for (const sql of migrationSql()) await pg.exec(sql);
  return pg;
}

export async function createUser(pg: PGlite, email: string, fullName = email.split('@')[0]) {
  const r = await pg.query<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
    [email, JSON.stringify({ full_name: fullName })],
  );
  return r.rows[0].id;
}

export function clientFor(pg: PGlite, userId: string | null, email?: string) {
  const claims: Claims = userId ? { role: 'authenticated', sub: userId, email } : { role: 'anon' };
  return new LocalDb(pg, () => claims);
}

export function serviceClient(pg: PGlite) {
  return new LocalDb(pg, () => ({ role: 'service_role' }));
}

export async function sql<T = Record<string, unknown>>(pg: PGlite, q: string, params: unknown[] = []) {
  return (await pg.query<T>(q, params)).rows;
}

/** Simulates an anonymous careers-page resume upload through storage RLS. */
export async function anonUpload(pg: PGlite, bucket: string, name: string) {
  return runAs(pg, { role: 'anon' }, (tx) =>
    tx.query(`insert into storage.objects (bucket_id, name, data) values ($1, $2, $3)`, [bucket, name, new Uint8Array([37, 80, 68, 70])]),
  );
}

export async function uploadAs(pg: PGlite, userId: string, bucket: string, name: string) {
  return runAs(pg, { role: 'authenticated', sub: userId }, (tx) =>
    tx.query(`insert into storage.objects (bucket_id, name, data) values ($1, $2, $3)`, [bucket, name, new Uint8Array([37, 80, 68, 70])]),
  );
}

export async function readObjectAs(pg: PGlite, userId: string | null, bucket: string, name: string) {
  return runAs(pg, userId ? { role: 'authenticated', sub: userId } : { role: 'anon' }, async (tx) =>
    (await tx.query(`select name from storage.objects where bucket_id = $1 and name = $2`, [bucket, name])).rows.length > 0,
  );
}
