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
  type RealtimeApi,
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
    // a missing filter value must never widen a query: match nothing
    if (f.value === undefined) { q = q.in(f.column, []); continue; }
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

export function createDb(sb: SupabaseClient): DbApi {
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

export function createStorage(sb: SupabaseClient): StorageApi {
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

/** Edge functions answer errors as JSON { error }; supabase-js wraps them, so read the body for a readable message. */
async function functionError(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: Response } | null)?.context;
  try {
    const body = ctx && typeof ctx.json === 'function' ? await ctx.clone().json() : null;
    if (body?.error) return String(body.error);
  } catch {
    /* not JSON */
  }
  return fallback;
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
    async signInWithEmployeeId(employeeId, password) {
      const { data, error } = await sb.functions.invoke('employee-auth', { body: { action: 'login', employee_id: employeeId, password } });
      if (error || !data?.access_token) throw new BackendError(await functionError(error, 'Invalid Employee ID or password'));
      const { data: s, error: e2 } = await sb.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
      if (e2 || !s.user) throw new BackendError(e2?.message ?? 'Could not sign in');
      return toUser(s.user)!;
    },
    async activateAccount(token, password) {
      const { data, error } = await sb.functions.invoke('employee-auth', { body: { action: 'activate', token, password } });
      if (error || !data?.email) throw new BackendError(await functionError(error, 'Could not set the password'));
      return { email: data.email as string };
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

function createRealtime(sb: SupabaseClient): RealtimeApi {
  return {
    subscribe(channel, tables, onEvent) {
      // One channel per table: Supabase Realtime silently delivers NOTHING on a channel if any of its postgres_changes
      // bindings names a table that is missing or not published (verified live). Separate channels keep the others working
      // across schema versions (e.g. before/after migration 1200 changes which chat tables are published).
      const suffix = Math.random().toString(36).slice(2, 8);
      const channels = tables.map((table) => {
        let subscribedOnce = false;
        const ch = sb.channel(`${channel}-${table}-${suffix}`);
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) =>
          onEvent({ table, eventType: payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE', new: payload.new as Record<string, unknown> }));
        ch.subscribe((status) => {
          // after a reconnect, ask consumers to resync anything missed while offline
          if (status === 'SUBSCRIBED') {
            if (subscribedOnce) onEvent({ table: '*', eventType: 'RESYNC' });
            subscribedOnce = true;
          }
        });
        return ch;
      });
      const onOnline = () => onEvent({ table: '*', eventType: 'RESYNC' });
      window.addEventListener('online', onOnline);
      return () => {
        window.removeEventListener('online', onOnline);
        for (const ch of channels) void sb.removeChannel(ch);
      };
    },
  };
}

export function createSupabaseBackend(url: string, anonKey: string): Backend {
  const sb = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  return {
    mode: 'supabase',
    realtime: createRealtime(sb),
    auth: createAuth(sb),
    db: createDb(sb),
    storage: createStorage(sb),
    async processEmails() {
      // Delivery happens server-side: the service role key exists only inside the Edge Function.
      await sb.functions.invoke('process-emails', { body: {} }).catch(() => undefined);
    },
  };
}
