// Logical backup of the Supabase database: every table in the public schema is exported to JSON (one file per table)
// in backups/<project>/<timestamp>/, plus a manifest with row counts. Read-only — nothing is changed.
//
// Usage (keys are read from the environment or the gitignored supabase/.temp/service-role-key, never committed):
//   node scripts/backup-export.mjs
//   SUPABASE_URL=https://xyz.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup-export.mjs
//
// The service role key bypasses RLS: keep the backups folder private (it is gitignored) and store copies offline.
// Storage files (resumes, documents) are listed in storage-objects.json; download them from the dashboard if needed.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const envFile = path.join(root, '.env.local');
const env = Object.fromEntries((fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').split(/\r?\n/).filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const URL_ = (process.env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const keyFile = path.join(root, 'supabase/.temp/service-role-key');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
if (!URL_ || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or provide .env.local and supabase/.temp/service-role-key).');
  process.exit(1);
}
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// table list from the PostgREST OpenAPI description (tables and views exposed in the public schema)
const spec = await (await fetch(`${URL_}/rest/v1/`, { headers })).json();
const tables = Object.keys(spec.definitions ?? {}).filter((t) => !t.startsWith('v_')).sort();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const ref = new URL(URL_).hostname.split('.')[0];
const dir = path.join(root, 'backups', ref, stamp);
fs.mkdirSync(dir, { recursive: true });

const manifest = { project: ref, created_at: new Date().toISOString(), tables: {} };
for (const t of tables) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/${t}?select=*`, { headers: { ...headers, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
    if (!res.ok) { manifest.tables[t] = { error: `${res.status} ${await res.text()}` }; break; }
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  if (!manifest.tables[t]) {
    fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(rows));
    manifest.tables[t] = { rows: rows.length };
  }
}
// storage object list (metadata only)
const objects = [];
for (const bucket of ['resumes', 'documents', 'company-assets', 'chat-attachments']) {
  const res = await fetch(`${URL_}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 1000 }) });
  if (res.ok) objects.push({ bucket, top_level: await res.json() });
}
fs.writeFileSync(path.join(dir, 'storage-objects.json'), JSON.stringify(objects, null, 1));
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
const total = Object.values(manifest.tables).reduce((a, t) => a + (t.rows ?? 0), 0);
const failed = Object.entries(manifest.tables).filter(([, t]) => t.error).map(([n]) => n);
console.log(`Backup written to ${dir}: ${tables.length} tables, ${total} rows${failed.length ? `; FAILED: ${failed.join(', ')}` : ''}`);
if (failed.length) process.exit(2);
