import clsx from 'clsx';
import { Bell, CheckCheck, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, EmptyState, ErrorState, PageHeader, PageLoader, Pagination, Badge } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { useAction, useList } from '@/lib/hooks';
import { useState } from 'react';

interface N { id: string; type: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }

export function Notifications() {
  const { user } = useSession();
  const { companyId } = useCompany();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useList<N>(user ? {
    table: 'notifications',
    filters: [{ column: 'user_id', op: 'eq', value: user.id }, { column: 'company_id', op: 'eq', value: companyId }, ...(unreadOnly ? [{ column: 'read_at', op: 'is' as const, value: null }] : [])],
    order: [{ column: 'created_at', ascending: false }], range: [(page - 1) * 20, page * 20 - 1],
  } : null);
  const markAll = useAction(() => api.db.rpc('mark_notifications_read', { p_ids: null }), { success: 'All notifications marked as read' });
  const remove = useAction((id: string) => api.db.remove('notifications', id), { success: 'Notification removed' });
  const rows = q.data?.rows ?? [];
  return (
    <>
      <PageHeader title="Notifications" description="Activity that needs your attention."
        actions={<>
          <Button variant="secondary" onClick={() => { setUnreadOnly(!unreadOnly); setPage(1); }}>{unreadOnly ? 'Show all' : 'Unread only'}</Button>
          <Button variant="secondary" icon={<CheckCheck className="h-4 w-4" />} loading={markAll.isPending} onClick={() => markAll.mutate()}>Mark all read</Button>
        </>} />
      <div className="card overflow-hidden">
        {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? (
          <EmptyState icon={<Bell className="h-6 w-6" />} title={unreadOnly ? 'No unread notifications' : 'No notifications yet'} />
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {rows.map((n) => (
                <li key={n.id} className={clsx('flex items-start gap-3 px-5 py-4', !n.read_at && 'bg-brand-50/40')}>
                  <span className={clsx('mt-2 h-2 w-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-brand-500')} />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { void api.db.rpc('mark_notifications_read', { p_ids: [n.id] }).then(() => q.refetch()); if (n.link) navigate(n.link); }}>
                    <p className="flex items-center gap-2 text-sm font-medium text-slate-900">{n.title} <Badge>{n.type}</Badge></p>
                    {n.body && <p className="text-sm text-slate-600">{n.body}</p>}
                    <p className="mt-0.5 text-xs text-slate-400" title={fmtDateTime(n.created_at)}>{fmtRelative(n.created_at)}</p>
                  </button>
                  <Button size="sm" variant="ghost" aria-label="Delete notification" onClick={() => remove.mutate(n.id)}><Trash2 className="h-4 w-4 text-slate-400" /></Button>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={20} total={q.data?.count ?? 0} onPage={setPage} />
          </>
        )}
      </div>
    </>
  );
}
