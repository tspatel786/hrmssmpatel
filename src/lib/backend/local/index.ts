// Local DEMO backend: a real PostgreSQL (PGlite/WASM) running in the browser,
// persisted to IndexedDB, with the SAME migrations, RLS policies and RPCs as
// production Supabase. Auth/storage/email are local equivalents:
//   - auth: PBKDF2 password hashes in auth.users, session in localStorage
//   - storage: bytes stored in storage.objects (shim column) through RLS
//   - email: queued emails are "delivered" by a mock worker (status=sent, provider=mock)
import { PGlite } from '@electric-sql/pglite';
import { BackendError, type AuthApi, type AuthUser, type Backend, type RealtimeApi, type StorageApi } from '../types';
import { LocalDb, runAs, type Claims } from './localDb';

const shimSql = import.meta.glob('../../../../supabase/local/shim.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const migrationFiles = import.meta.glob('../../../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const SESSION_KEY = 'talentflow-demo-session';
export const DEMO_DB_NAME = 'idb://talentflow-hrms-demo';

export function orderedMigrations(): { name: string; sql: string }[] {
  const shim = Object.values(shimSql)[0];
  return [
    { name: '00000000000000_local_shim.sql', sql: shim },
    ...Object.entries(migrationFiles)
      .map(([path, sql]) => ({ name: path.split('/').pop()!, sql }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

export async function migrate(pg: PGlite, migrations = orderedMigrations()): Promise<boolean> {
  await pg.exec(`create schema if not exists local_meta;
    create table if not exists local_meta.migrations (name text primary key, applied_at timestamptz default now());`);
  const done = new Set((await pg.query<{ name: string }>('select name from local_meta.migrations')).rows.map((r) => r.name));
  const fresh = done.size === 0;
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    await pg.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('insert into local_meta.migrations (name) values ($1)', [m.name]);
    });
  }
  return fresh;
}

// ---------------- auth ----------------
const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = 120000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}
async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [, it, salt] = stored.split('$');
  const candidate = await hashPassword(password, unb64(salt), Number(it));
  // constant-time-ish compare
  if (candidate.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

export function validatePassword(pw: string) {
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    throw new BackendError('Password must be at least 8 characters and contain letters and numbers');
  }
}

export async function createAuthUser(pg: PGlite, email: string, password: string, fullName: string): Promise<AuthUser> {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new BackendError('Enter a valid email address');
  validatePassword(password);
  const exists = await pg.query('select 1 from auth.users where lower(email) = $1', [e]);
  if (exists.rows.length) throw new BackendError('An account with this email already exists. Please sign in.');
  const hash = await hashPassword(password);
  const r = await pg.query<{ id: string }>(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data) values ($1, $2, $3) returning id`,
    [e, hash, JSON.stringify({ full_name: fullName })],
  );
  return { id: r.rows[0].id, email: e, fullName };
}

function createLocalAuth(pg: PGlite, onUser: (u: AuthUser | null) => void): AuthApi & { current: () => AuthUser | null } {
  let current: AuthUser | null = null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) current = JSON.parse(raw);
  } catch {
    current = null;
  }
  const listeners = new Set<(u: AuthUser | null) => void>();
  const set = (u: AuthUser | null) => {
    current = u;
    try {
      if (u) localStorage.setItem(SESSION_KEY, JSON.stringify(u));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* storage unavailable */
    }
    onUser(u);
    listeners.forEach((l) => l(u));
  };
  return {
    current: () => current,
    async getUser() {
      if (!current) return null;
      const r = await pg.query('select 1 from auth.users where id = $1', [current.id]);
      if (!r.rows.length) {
        set(null);
        return null;
      }
      return current;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async signIn(email, password) {
      const r = await pg.query<{ id: string; email: string; encrypted_password: string; raw_user_meta_data: { full_name?: string } }>(
        'select id, email, encrypted_password, raw_user_meta_data from auth.users where lower(email) = $1',
        [email.trim().toLowerCase()],
      );
      const u = r.rows[0];
      if (!u || !(await verifyPassword(password, u.encrypted_password))) throw new BackendError('Invalid email or password');
      const user = { id: u.id, email: u.email, fullName: u.raw_user_meta_data?.full_name };
      set(user);
      return user;
    },
    async signUp(email, password, fullName) {
      const user = await createAuthUser(pg, email, password, fullName);
      set(user);
      return { user, needsConfirmation: false };
    },
    async signOut() {
      set(null);
    },
    async requestPasswordReset() {
      throw new BackendError('Password reset emails require Supabase mode. In demo mode, sign in with a demo account or reset the demo data.');
    },
    async updatePassword(newPassword) {
      if (!current) throw new BackendError('Not signed in');
      validatePassword(newPassword);
      await pg.query('update auth.users set encrypted_password = $1 where id = $2', [await hashPassword(newPassword), current.id]);
    },
  };
}

// ---------------- storage ----------------
function createLocalStorage(pg: PGlite, claims: () => Claims): StorageApi {
  const MAX: Record<string, number> = { resumes: 5242880, documents: 10485760, 'company-assets': 1048576 };
  return {
    async upload(bucket, path, file, contentType) {
      if (file.size > (MAX[bucket] ?? 10485760)) throw new BackendError('File is too large');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = JSON.stringify({ mimetype: contentType || file.type, size: file.size });
      await runAs(pg, claims(), async (tx) => {
        if (bucket !== 'resumes') {
          const upd = await tx.query(`update storage.objects set data = $3, metadata = $4, updated_at = now() where bucket_id = $1 and name = $2`, [bucket, path, bytes, meta]);
          if (upd.affectedRows) return;
        }
        await tx.query(`insert into storage.objects (bucket_id, name, data, metadata) values ($1, $2, $3, $4)`, [bucket, path, bytes, meta]);
      });
    },
    async download(bucket, path) {
      const row = await runAs(pg, claims(), async (tx) =>
        (await tx.query<{ data: Uint8Array; metadata: { mimetype?: string } }>(`select data, metadata from storage.objects where bucket_id = $1 and name = $2`, [bucket, path])).rows[0],
      );
      if (!row) throw new BackendError('File not found or access denied');
      return new Blob([row.data], { type: row.metadata?.mimetype || 'application/octet-stream' });
    },
    async signedUrl(bucket, path) {
      return URL.createObjectURL(await this.download(bucket, path));
    },
    async publicUrl(bucket, path) {
      const blob = await this.download(bucket, path);
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      return `data:${blob.type};base64,${btoa(bin)}`;
    },
    async remove(bucket, path) {
      await runAs(pg, claims(), (tx) => tx.query(`delete from storage.objects where bucket_id = $1 and name = $2`, [bucket, path]));
    },
  };
}

// ---------------- email worker (mock delivery) ----------------
export async function deliverQueuedEmails(pg: PGlite): Promise<number> {
  const svc: Claims = { role: 'service_role' };
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const batch = await runAs(pg, svc, async (tx) => (await tx.query<{ id: string }>('select id from public.claim_email_batch(50)')).rows);
    if (!batch.length) break;
    for (const e of batch) {
      await runAs(pg, svc, (tx) =>
        tx.query('select public.complete_email($1, true, $2, $3, null)', [e.id, 'mock', `mock-${e.id.slice(0, 8)}`]),
      );
    }
    total += batch.length;
  }
  return total;
}

export interface LocalBackendOptions {
  dataDir?: string;
  seed?: boolean;
}

let pgInstance: PGlite | null = null;

export async function createLocalBackend(opts: LocalBackendOptions = {}): Promise<Backend> {
  const pg = await PGlite.create(opts.dataDir ?? DEMO_DB_NAME);
  pgInstance = pg;
  const fresh = await migrate(pg);
  if (fresh && opts.seed !== false) {
    const { seedDemoData } = await import('./seed');
    await seedDemoData(pg);
    await deliverQueuedEmails(pg);
  }
  const auth = createLocalAuth(pg, () => undefined);
  const claims = (): Claims => {
    const u = auth.current();
    return u ? { role: 'authenticated', sub: u.id, email: u.email } : { role: 'anon' };
  };
  const db = new LocalDb(pg, claims);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  const processEmails = async () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) return;
      running = true;
      try {
        await deliverQueuedEmails(pg);
      } finally {
        running = false;
      }
    }, 400);
  };
  setInterval(() => void processEmails(), 15000);
  // Demo realtime: one in-browser database per tab, so a short poll is an exact equivalent of change feeds.
  const realtime: RealtimeApi = {
    subscribe(_channel, _tables, onEvent) {
      const t = setInterval(() => onEvent({ table: '*', eventType: 'RESYNC' }), 2500);
      return () => clearInterval(t);
    },
  };
  return { mode: 'demo', realtime, auth, db, storage: createLocalStorage(pg, claims), processEmails };
}

/** Wipes the in-browser demo database (used by "Reset demo data"). */
export async function resetLocalDatabase(): Promise<void> {
  try {
    await pgInstance?.close();
  } catch {
    /* ignore */
  }
  localStorage.removeItem(SESSION_KEY);
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DEMO_DB_NAME.replace('idb://', '/pglite/'));
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
