import clsx from 'clsx';
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, FilterX } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { downloadCsv } from '@/lib/csv';
import { fetchAll, type useTable } from '@/lib/hooks';
import { STATUS_TONES } from '@/lib/constants';
import { titleCase } from '@/lib/format';
import { Badge, Button, EmptyState, ErrorState, Pagination, SearchInput, Select, Skeleton, type Option } from './ui';

export function StatusBadge({ kind, value }: { kind: keyof typeof STATUS_TONES; value?: string | null }) {
  if (!value) return <span className="text-slate-400">—</span>;
  return <Badge tone={STATUS_TONES[kind]?.[value] ?? 'gray'} dot>{titleCase(value)}</Badge>;
}

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
  hideOnMobile?: boolean;
  /** value used for CSV export (defaults to row[key]) */
  csv?: (row: T) => unknown;
}

export interface FilterDef {
  key: string;
  label: string;
  options: Option[];
}

type TableApi = ReturnType<typeof useTable>;

export function DataTable<T extends { id?: string | number }>({
  table, columns, filters = [], searchPlaceholder, onRowClick, empty, toolbar, exportName, rowActions, mobileCard,
}: {
  table: TableApi;
  columns: Column<T>[];
  filters?: FilterDef[];
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  empty?: { title: string; description?: string; action?: ReactNode; icon?: ReactNode };
  toolbar?: ReactNode;
  exportName?: string;
  rowActions?: (row: T) => ReactNode;
  mobileCard?: (row: T) => ReactNode;
}) {
  const rows = table.rows as T[];
  const { isLoading, isError, error, refetch, isFetching } = table.result;

  const doExport = async () => {
    if (!table.query) return;
    try {
      const all = await fetchAll<T>({ ...table.query, range: undefined });
      downloadCsv(`${exportName}-${new Date().toISOString().slice(0, 10)}.csv`,
        columns.filter((c) => c.key !== '_actions').map((c) => c.header),
        all.map((r) => columns.filter((c) => c.key !== '_actions').map((c) => (c.csv ? c.csv(r) : (r as Record<string, unknown>)[c.key]))));
      toast.success(`Exported ${all.length} rows`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
        {searchPlaceholder && <SearchInput className="lg:w-72" value={table.search} onChange={table.setSearch} placeholder={searchPlaceholder} />}
        <div className="flex flex-1 flex-wrap items-center gap-2">
          {filters.map((f) => (
            <Select key={f.key} className="w-auto min-w-[140px] py-1.5" aria-label={f.label} value={table.filters[f.key] ?? ''}
              onChange={(e) => table.setFilter(f.key, e.target.value)} options={f.options} placeholder={`All ${f.label.toLowerCase()}`} />
          ))}
          {table.hasActiveFilters && (
            <Button variant="ghost" size="sm" icon={<FilterX className="h-4 w-4" />} onClick={table.clearFilters}>Clear</Button>
          )}
          {isFetching && !isLoading && <span className="text-xs text-slate-400">Updating…</span>}
        </div>
        <div className="flex items-center gap-2">
          {toolbar}
          {exportName && (
            <Button variant="secondary" size="sm" icon={<Download className="h-4 w-4" />} onClick={doExport} disabled={!table.total}>Export</Button>
          )}
        </div>
      </div>

      {isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="space-y-3 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={empty?.icon}
          title={table.hasActiveFilters ? 'No matching results' : empty?.title ?? 'Nothing here yet'}
          description={table.hasActiveFilters ? 'Try adjusting your search or filters.' : empty?.description}
          action={table.hasActiveFilters ? <Button variant="secondary" size="sm" onClick={table.clearFilters}>Clear filters</Button> : empty?.action}
        />
      ) : (
        <>
          {mobileCard && (
            <ul className="divide-y divide-slate-100 md:hidden">
              {rows.map((r, i) => (
                <li key={r.id ?? i} className={clsx('p-4', onRowClick && 'cursor-pointer active:bg-slate-50')} onClick={() => onRowClick?.(r)}>
                  {mobileCard(r)}
                </li>
              ))}
            </ul>
          )}
          <div className={clsx('overflow-x-auto', mobileCard && 'hidden md:block')}>
            <table className="table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={clsx(c.className, c.hideOnMobile && 'hidden lg:table-cell')} scope="col"
                      aria-sort={table.sort.column === c.key ? (table.sort.ascending ? 'ascending' : 'descending') : undefined}>
                      {c.sortable ? (
                        <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-slate-800" onClick={() => table.toggleSort(c.key)}>
                          {c.header}
                          {table.sort.column === c.key ? (table.sort.ascending ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ChevronsUpDown className="h-3 w-3 opacity-40" />}
                        </button>
                      ) : c.header}
                    </th>
                  ))}
                  {rowActions && <th className="w-px"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id ?? i} className={clsx(onRowClick && 'cursor-pointer')} onClick={() => onRowClick?.(r)}>
                    {columns.map((c) => (
                      <td key={c.key} className={clsx(c.className, c.hideOnMobile && 'hidden lg:table-cell')}>
                        {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '—')}
                      </td>
                    ))}
                    {rowActions && (
                      <td className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>{rowActions(r)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={table.page} pageSize={table.pageSize} total={table.total} onPage={table.setPage} onPageSize={table.setPageSize} />
        </>
      )}
    </div>
  );
}
