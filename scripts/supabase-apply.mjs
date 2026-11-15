// Applies pending SQL migrations to a Supabase project through the Management API.
// Usage (token is read from the environment, never from a file):
//   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=abcd... node scripts/supabase-apply.mjs [--dry-run]
// Records applied versions in supabase_migrations.schema_migrations (same table the Supabase CLI uses).
import fs from 'node:fs';
import path from 'node:path';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
const dry = process.argv.includes('--dry-run');
if (!token || !ref) {
  console.error('Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF');
  process.exit(1);
}

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

await query(`create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);`);
const applied = new Set((await query('select version from supabase_migrations.schema_migrations')).map((r) => r.version));
const dir = path.resolve('supabase/migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
let count = 0;
for (const f of files) {
  const version = f.split('_')[0];
  if (applied.has(version)) {
    console.log('skip ', f);
    continue;
  }
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  if (dry) {
    console.log('would apply', f);
    continue;
  }
  process.stdout.write(`apply ${f} ... `);
  try {
    // one transaction per migration: all-or-nothing
    await query(`begin;\n${sql}\n;insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${f.replace(/'/g, "''")}');\ncommit;`);
    console.log('ok');
    count++;
  } catch (e) {
    console.log('FAILED');
    console.error(e.message);
    process.exit(1);
  }
}
console.log(`${count} migration(s) applied`);
