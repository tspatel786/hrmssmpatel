import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  BackendError,
  friendlyError,
  type AuthApi,
  type AuthUser,
  type Backend,
  type DbApi,
  type Filter,
  type ListQuery,
  type StorageApi,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgrest builder generics add no value here
type Q = any;

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw friendlyError(res.error.message, res.error.code);
  return res.data;
}

function applyFilters(q: Q, filters: Filter[] = []): Q {
  for (const f of filters) {
    if (f.value === undefined) continue;
    switch (f.op) {
      case 'eq': q = q.eq(f.column, f.value); break;
      case 'neq': q = q.neq(f.column, f.value); break;
      case 'gt': q = q.gt(f.column, f.value); break;
      case 'gte': q = q.gte(f.column, f.value); break;
      case 'lt': q = q.lt(f.column, f.value); break;
      case 'lte': q = q.lte(f.column, f.value); break;
      case 'ilike': q = q.ilike(f.column, String(f.value)); break;
      case 'in': q = q.in(f.column, f.value as unknown[]); break;
      case 'contains': q = q.contains(f.column, f.value as unknown[]); break;
      case 'is':
        q = f.value === 'not_null' ? q.not(f.column, 'is', null) : q.is(f.column, f.value as boolean | null);
        break;
    }
  }
  return q;
}

function createDb(sb: SupabaseClient): DbApi {
  return {
    async list<T>(query: ListQuery) {
      let q: Q = sb.from(query.table).select(query.columns || '*', { count: query.count === false ? undefined : 'exact' });
      q = applyFilters(q, query.filters);
      if (query.search?.term.trim()) {
        const term = query.search.term.trim().replace(/[,()"\\%*]/g, ' ').trim();
        if (term) q = q.or(query.search.columns.map((c) => `${c}.ilike."%${term}%"`).join(','));
      }
      for (const o of query.order ?? []) q = q.order(o.column, { ascending: o.ascending !== false, nullsFirst: false });
      if (query.range) q = q.range(query.range[0], query.range[1]);
      const res = await q;
      const rows = check(res) as T[];
      return { rows, count: res.count ?? rows.length };
    },
    async get<T>(table: string, id: string, column = 'id') {
      return check(await sb.from(table).select('*').eq(column, id).maybeSingle()) as T | null;
    },
    async insert<T>(table: string, values: Record<string, unknown>) {
      return check(await sb.from(table).insert(values).select().single()) as T;
    },
    async insertMany(table: string, values: Record<string, unknown>[]) {
      if (values.length) check(await sb.from(table).insert(values));
    },
    async update<T>(table: string, id: string, values: Record<string, unknown>, column = 'id') {
      const row = check(await sb.from(table).update(values).eq(column, id).select().maybeSingle());
      if (!row) throw new BackendError('Record not found or you do not have permission to change it.', '42501');
      return row as T;
    },
    async remove(table: string, id: string, column = 'id') {
      const res = await sb.from(table).delete({ count: 'exact' }).eq(column, id);
      check(res);
      if (!res.count) throw new BackendError('Record not found or you do not have permission to delete it.', '42501');
    },
    async removeWhere(table: string, filters: Filter[]) {
      if (!filters.length) throw new BackendError('Refusing to delete without filters');
      check(await applyFilters(sb.from(table).delete(), filters));
    },
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      return check(await sb.rpc(fn, args)) as T;
    },
  };
}

function createStorage(sb: SupabaseClient): StorageApi {
  return {
    async upload(bucket, path, file, contentType) {
      // anonymous careers uploads are insert-only (no upsert => no select/update policy needed)
      const { error } = await sb.storage.from(bucket).upload(path, file, { contentType, upsert: bucket !== 'resumes' });
      if (error) throw friendlyError(error.message);
    },
    async download(bucket, path) {
      const { data, error } = await sb.storage.from(bucket).download(path);
      if (error || !data) throw friendlyError(error?.message ?? 'File not found');
      return data;
    },
    async signedUrl(bucket, path, expires = 300) {
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, expires);
      if (error || !data) throw friendlyError(error?.message ?? 'File not found');
      return data.signedUrl;
    },
    async publicUrl(bucket, path) {
      return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
    },
    async remove(bucket, path) {
      const { error } = await sb.storage.from(bucket).remove([path]);
      if (error) throw friendlyError(error.message);
    },
  };
}

function toUser(u: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null | undefined): AuthUser | null {
  if (!u) return null;
  return { id: u.id, email: u.email ?? '', fullName: (u.user_metadata?.full_name as string) ?? undefined };
}

function createAuth(sb: SupabaseClient): AuthApi {
  return {
    async getUser() {
      const { data } = await sb.auth.getSession();
      return toUser(data.session?.user);
    },
    onChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_e, session) => cb(toUser(session?.user)));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new BackendError(error.message === 'Invalid login credentials' ? 'Invalid email or password' : error.message);
      return toUser(data.user)!;
    },
    async signUp(email, password, fullName) {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName }, emailRedirectTo: `${window.location.origin}/login` },
      });
      if (error) throw new BackendError(error.message);
      return { user: toUser(data.session?.user ?? null), needsConfirmation: !data.session };
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async requestPasswordReset(email, redirectTo) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw new BackendError(error.message);
    },
    async updatePassword(password) {
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw new BackendError(error.message);
    },
  };
}

export function createSupabaseBackend(url: string, anonKey: string): Backend {
  const sb = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  return {
    mode: 'supabase',
    auth: createAuth(sb),
    db: createDb(sb),
    storage: createStorage(sb),
    async processEmails() {
      // Delivery happens server-side: the service role key exists only inside the Edge Function.
      await sb.functions.invoke('process-emails', { body: {} }).catch(() => undefined);
    },
  };
}
