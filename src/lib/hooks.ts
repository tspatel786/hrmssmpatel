import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from './backend';
import type { Filter, ListQuery } from './backend/types';

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useList<T = Record<string, unknown>>(query: ListQuery | null, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: ['list', query?.table, query],
    queryFn: () => api.db.list<T>(query!),
    enabled: !!query && opts.enabled !== false,
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
  });
}

export function useRecord<T = Record<string, unknown>>(table: string, id: string | undefined, column = 'id') {
  return useQuery({
    queryKey: ['get', table, id, column],
    queryFn: () => api.db.get<T>(table, id!, column),
    enabled: !!id,
  });
}

export function useRpc<T = unknown>(fn: string, args: Record<string, unknown> | null, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: ['rpc', fn, args],
    queryFn: () => api.db.rpc<T>(fn, args ?? {}),
    enabled: args !== null && opts.enabled !== false,
    refetchInterval: opts.refetchInterval,
  });
}

/**
 * Wraps a mutation with consistent UX: toast on success (only after the server
 * confirmed it) / on error, global cache invalidation and email queue processing.
 */
export function useAction<TArgs = void, TResult = unknown>(
  fn: (args: TArgs) => Promise<TResult>,
  opts: { success?: string | ((r: TResult) => string); onSuccess?: (r: TResult, args: TArgs) => void; silent?: boolean } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r, args) => {
      await qc.invalidateQueries();
      void api.processEmails();
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r, args);
    },
    onError: (e: Error) => {
      if (!opts.silent) toast.error(e.message || 'Something went wrong');
    },
  });
}

export interface TableState {
  page: number;
  pageSize: number;
  search: string;
  filters: Record<string, string>;
  sort: { column: string; ascending: boolean };
}

/** State + query builder for list pages: search, filters, sorting and pagination. */
export function useTable(opts: {
  table: string;
  companyId?: string | null;
  searchColumns?: string[];
  defaultSort: { column: string; ascending?: boolean };
  pageSize?: number;
  baseFilters?: Filter[];
  filterOps?: Record<string, Filter['op']>;
  /** tie-breaker order applied after the user-selected sort */
  thenBy?: { column: string; ascending?: boolean }[];
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(opts.pageSize ?? 20);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState({ column: opts.defaultSort.column, ascending: opts.defaultSort.ascending ?? true });
  const debounced = useDebounced(search);
  useEffect(() => setPage(1), [debounced, filters, pageSize]);

  const baseKey = JSON.stringify(opts.baseFilters ?? []);
  const query: ListQuery | null = useMemo(() => {
    if (opts.companyId === null) return null;
    const f: Filter[] = [...(opts.baseFilters ?? [])];
    if (opts.companyId) f.push({ column: 'company_id', op: 'eq', value: opts.companyId });
    for (const [k, v] of Object.entries(filters)) {
      if (v === '' || v === undefined) continue;
      const op = opts.filterOps?.[k] ?? 'eq';
      const column = k.replace(/__(from|to)$/, '');
      f.push({ column, op, value: op === 'ilike' ? `%${v}%` : v === 'true' ? true : v === 'false' ? false : v });
    }
    return {
      table: opts.table,
      filters: f,
      search: opts.searchColumns && debounced ? { columns: opts.searchColumns, term: debounced } : undefined,
      order: [{ column: sort.column, ascending: sort.ascending }, ...(opts.thenBy ?? [])],
      range: [(page - 1) * pageSize, page * pageSize - 1],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.table, opts.companyId, baseKey, filters, debounced, sort, page, pageSize]);

  const result = useList(query);
  return {
    query,
    result,
    rows: (result.data?.rows ?? []) as unknown[],
    total: result.data?.count ?? 0,
    page, setPage, pageSize, setPageSize, search, setSearch, filters,
    setFilter: (k: string, v: string) => setFilters((p) => ({ ...p, [k]: v })),
    clearFilters: () => { setFilters({}); setSearch(''); },
    sort,
    toggleSort: (column: string) => setSort((s) => ({ column, ascending: s.column === column ? !s.ascending : true })),
    hasActiveFilters: !!search || Object.values(filters).some(Boolean),
  };
}

/** Fetch all rows (paged) of a list query for CSV export. */
export async function fetchAll<T>(query: ListQuery, max = 10000): Promise<T[]> {
  const out: T[] = [];
  const size = 500;
  for (let from = 0; from < max; from += size) {
    const { rows } = await api.db.list<T>({ ...query, range: [from, from + size - 1], count: false });
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}
