// PGlite-backed implementation of DbApi. Every call runs in its own transaction
// with `SET LOCAL ROLE` + JWT claims, exactly like PostgREST does on Supabase,
// so Row Level Security policies are enforced identically.
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { types } from '@electric-sql/pglite';
import { assertIdent, BackendError, friendlyError, type DbApi, type Filter, type ListQuery, type ListResult } from '../types';

export interface Claims {
  role: 'anon' | 'authenticated' | 'service_role';
  sub?: string;
  email?: string;
}

const toIso = (v: string) => {
  // Postgres text timestamptz "2026-01-01 10:00:00.123+00" -> ISO string (like PostgREST)
  const s = v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
};

export const PARSERS = {
  [types.NUMERIC]: (v: string) => Number(v),
  [types.INT8]: (v: string) => Number(v),
  [types.DATE]: (v: string) => v,
  [types.TIMESTAMPTZ]: toIso,
  [types.TIMESTAMP]: (v: string) => v.replace(' ', 'T'),
  [types.TIME]: (v: string) => v,
};

function serialize(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

export async function runAs<T>(db: PGlite, claims: Claims, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)`, [
        JSON.stringify({ ...claims }),
        claims.role,
      ]);
      return fn(tx);
    });
  } catch (e) {
    if (e instanceof BackendError) throw e;
    const err = e as { message?: string; code?: string };
    throw friendlyError(err.message ?? String(e), err.code);
  }
}

// cached metadata about functions: does it return a set?
const fnCache = new Map<string, boolean>();

export class LocalDb implements DbApi {
  constructor(
    private db: PGlite,
    private getClaims: () => Claims,
  ) {}

  private buildWhere(filters: Filter[] = [], search: ListQuery['search'], params: unknown[]): string {
    const parts: string[] = [];
    for (const f of filters) {
      const col = assertIdent(f.column);
      if (f.value === undefined) continue;
      switch (f.op) {
        case 'eq': params.push(serialize(f.value)); parts.push(`${col} = $${params.length}`); break;
        case 'neq': params.push(serialize(f.value)); parts.push(`${col} is distinct from $${params.length}`); break;
        case 'gt': params.push(serialize(f.value)); parts.push(`${col} > $${params.length}`); break;
        case 'gte': params.push(serialize(f.value)); parts.push(`${col} >= $${params.length}`); break;
        case 'lt': params.push(serialize(f.value)); parts.push(`${col} < $${params.length}`); break;
        case 'lte': params.push(serialize(f.value)); parts.push(`${col} <= $${params.length}`); break;
        case 'ilike': params.push(String(f.value)); parts.push(`${col}::text ilike $${params.length}`); break;
        case 'is':
          if (f.value === null) parts.push(`${col} is null`);
          else if (f.value === 'not_null') parts.push(`${col} is not null`);
          else parts.push(`${col} is ${f.value ? 'true' : 'false'}`);
          break;
        case 'in': {
          const arr = (f.value as unknown[]) ?? [];
          if (arr.length === 0) { parts.push('false'); break; }
          const ph = arr.map((v) => { params.push(serialize(v)); return `$${params.length}`; });
          parts.push(`${col} in (${ph.join(',')})`);
          break;
        }
        case 'contains': {
          const arr = (f.value as unknown[]) ?? [];
          const ph = arr.map((v) => { params.push(String(v)); return `$${params.length}`; });
          parts.push(`${col} @> array[${ph.join(',')}]::text[]`);
          break;
        }
        default: throw new BackendError(`Unsupported filter ${f.op}`);
      }
    }
    if (search && search.term.trim()) {
      params.push(`%${search.term.trim().replace(/[%_\\]/g, (m) => '\\' + m)}%`);
      const p = `$${params.length}`;
      parts.push('(' + search.columns.map((c) => `${assertIdent(c)}::text ilike ${p}`).join(' or ') + ')');
    }
    return parts.length ? ` where ${parts.join(' and ')}` : '';
  }

  async list<T>(q: ListQuery): Promise<ListResult<T>> {
    const table = assertIdent(q.table);
    const cols = q.columns && q.columns !== '*' ? q.columns.split(',').map((c) => assertIdent(c.trim())).join(', ') : '*';
    const params: unknown[] = [];
    const where = this.buildWhere(q.filters, q.search, params);
    const order = q.order?.length
      ? ' order by ' + q.order.map((o) => `${assertIdent(o.column)} ${o.ascending === false ? 'desc' : 'asc'} nulls last`).join(', ')
      : '';
    let limit = '';
    if (q.range) {
      const [from, to] = q.range;
      limit = ` limit ${Math.max(0, to - from + 1)} offset ${Math.max(0, from)}`;
    }
    return runAs(this.db, this.getClaims(), async (tx) => {
      const res = await tx.query<T>(`select ${cols} from public.${table}${where}${order}${limit}`, params, { parsers: PARSERS });
      let count = res.rows.length;
      if (q.count !== false && q.range) {
        const c = await tx.query<{ n: number }>(`select count(*)::int as n from public.${table}${where}`, params);
        count = c.rows[0].n;
      }
      return { rows: res.rows, count };
    });
  }

  async get<T>(table: string, id: string, column = 'id'): Promise<T | null> {
    const t = assertIdent(table);
    return runAs(this.db, this.getClaims(), async (tx) => {
      const res = await tx.query<T>(`select * from public.${t} where ${assertIdent(column)} = $1 limit 1`, [id], { parsers: PARSERS });
      return res.rows[0] ?? null;
    });
  }

  async insert<T>(table: string, values: Record<string, unknown>): Promise<T> {
    const t = assertIdent(table);
    const keys = Object.keys(values).filter((k) => values[k] !== undefined);
    const params = keys.map((k) => serialize(values[k]));
    const sql = keys.length
      ? `insert into public.${t} (${keys.map(assertIdent).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning *`
      : `insert into public.${t} default values returning *`;
    return runAs(this.db, this.getClaims(), async (tx) => {
      const res = await tx.query<T>(sql, params, { parsers: PARSERS });
      if (!res.rows[0]) throw new BackendError('You do not have permission to perform this action.', '42501');
      return res.rows[0];
    });
  }

  async insertMany(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (!rows.length) return;
    const t = assertIdent(table);
    await runAs(this.db, this.getClaims(), async (tx) => {
      for (const values of rows) {
        const keys = Object.keys(values).filter((k) => values[k] !== undefined);
        await tx.query(
          `insert into public.${t} (${keys.map(assertIdent).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
          keys.map((k) => serialize(values[k])),
        );
      }
    });
  }

  async update<T>(table: string, id: string, values: Record<string, unknown>, column = 'id'): Promise<T> {
    const t = assertIdent(table);
    const keys = Object.keys(values).filter((k) => values[k] !== undefined);
    if (!keys.length) throw new BackendError('Nothing to update');
    const params = keys.map((k) => serialize(values[k]));
    params.push(id);
    const sql = `update public.${t} set ${keys.map((k, i) => `${assertIdent(k)} = $${i + 1}`).join(', ')} where ${assertIdent(column)} = $${params.length} returning *`;
    return runAs(this.db, this.getClaims(), async (tx) => {
      const res = await tx.query<T>(sql, params, { parsers: PARSERS });
      if (!res.rows[0]) throw new BackendError('Record not found or you do not have permission to change it.', '42501');
      return res.rows[0];
    });
  }

  async remove(table: string, id: string, column = 'id'): Promise<void> {
    const t = assertIdent(table);
    await runAs(this.db, this.getClaims(), async (tx) => {
      const res = await tx.query(`delete from public.${t} where ${assertIdent(column)} = $1`, [id]);
      if (!res.affectedRows) throw new BackendError('Record not found or you do not have permission to delete it.', '42501');
    });
  }

  async removeWhere(table: string, filters: Filter[]): Promise<void> {
    const t = assertIdent(table);
    const params: unknown[] = [];
    const where = this.buildWhere(filters, undefined, params);
    if (!where) throw new BackendError('Refusing to delete without filters');
    await runAs(this.db, this.getClaims(), (tx) => tx.query(`delete from public.${t}${where}`, params));
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const name = assertIdent(fn);
    if (!fnCache.has(name)) {
      const r = await this.db.query<{ retset: boolean }>(
        `select p.proretset as retset from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = $1 limit 1`,
        [name],
      );
      if (!r.rows[0]) throw new BackendError(`Unknown function ${name}`);
      fnCache.set(name, r.rows[0].retset);
    }
    const retset = fnCache.get(name)!;
    const keys = Object.keys(args).filter((k) => args[k] !== undefined);
    const params = keys.map((k) => serialize(args[k]));
    const argSql = keys.map((k, i) => `${assertIdent(k)} => $${i + 1}`).join(', ');
    return runAs(this.db, this.getClaims(), async (tx) => {
      if (retset) {
        const res = await tx.query(`select * from public.${name}(${argSql})`, params, { parsers: PARSERS });
        return res.rows as T;
      }
      const res = await tx.query<{ result: T }>(`select public.${name}(${argSql}) as result`, params, { parsers: PARSERS });
      return res.rows[0]?.result as T;
    });
  }
}
