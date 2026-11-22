// Team leave calendar (month view). Data comes from the team_leave_calendar RPC, which scopes visibility server-side
// (HR/approvers: company; managers: reports; everyone: own department's approved leave) and never returns reasons.
import { addMonths, eachDayOfInterval, endOfMonth, format, getISODay, startOfMonth } from 'date-fns';
import clsx from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, Card, EmptyState, ErrorState, PageLoader, Select } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { useRpc } from '@/lib/hooks';
import { useDepartments } from '@/lib/lookups';

interface Entry { request_id: string; employee_id: string; employee_name: string; employee_code: string; department_name: string | null;
  leave_type_name: string; leave_type_color: string; start_date: string; end_date: string; half_day: boolean; days: number; status: 'approved' | 'pending' }

export function LeaveCalendar({ companyId }: { companyId: string }) {
  const { company, can } = useCompany();
  const [month, setMonth] = useState(startOfMonth(new Date()));
  const [dept, setDept] = useState('');
  const depts = useDepartments();
  const companyWide = can('leave.view') || can('leave.approve');
  const from = format(month, 'yyyy-MM-dd');
  const to = format(endOfMonth(month), 'yyyy-MM-dd');
  const q = useRpc<Entry[]>('team_leave_calendar', { p_company: companyId, p_from: from, p_to: to, p_department: dept || null });
  const entries = useMemo(() => q.data ?? [], [q.data]);
  const days = eachDayOfInterval({ start: month, end: endOfMonth(month) });
  const working = company?.working_days ?? [1, 2, 3, 4, 5];
  const onDay = (k: string) => entries.filter((e) => e.start_date <= k && e.end_date >= k);
  const people = new Set(entries.map((e) => e.employee_id)).size;
  const today = format(new Date(), 'yyyy-MM-dd');

  return (
    <Card title={<span className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-brand-600" />Team calendar · {format(month, 'MMMM yyyy')}</span>} actions={<>
      {companyWide && <Select className="w-44 h-9" value={dept} onChange={(e) => setDept(e.target.value)} options={depts.options} placeholder="All departments" aria-label="Department" />}
      <Button size="sm" variant="ghost" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft className="h-4 w-4" /></Button>
      <Button size="sm" variant="secondary" onClick={() => setMonth(startOfMonth(new Date()))}>Today</Button>
      <Button size="sm" variant="ghost" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight className="h-4 w-4" /></Button>
    </>}>
      <p className="mb-3 text-xs text-slate-500">
        {companyWide ? 'Approved and pending leave across the company.' : 'Approved leave in your department, your direct reports and your own requests.'}{' '}
        {people > 0 && <strong className="text-slate-700">{people} {people === 1 ? 'person' : 'people'} on leave this month.</strong>}
      </p>
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} /> : (
        <>
          {/* desktop / tablet: month grid */}
          <div className="hidden sm:block">
            <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase text-slate-500">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-1">{d}</div>)}</div>
            <div className="grid grid-cols-7 gap-1" data-testid="leave-calendar">
              {Array.from({ length: getISODay(month) - 1 }).map((_, i) => <div key={`l${i}`} />)}
              {days.map((d) => {
                const k = format(d, 'yyyy-MM-dd');
                const list = onDay(k);
                const off = !working.includes(getISODay(d));
                return (
                  <div key={k} className={clsx('min-h-[88px] rounded-lg border p-1.5 text-xs', off ? 'border-slate-100 bg-slate-50' : 'border-slate-200', today === k && 'ring-2 ring-brand-500')}>
                    <span className="font-medium text-slate-700">{format(d, 'd')}</span>
                    {!off && list.slice(0, 3).map((e) => (
                      <span key={e.request_id} className={clsx('mt-1 block truncate rounded px-1 py-0.5 font-medium text-white', e.status === 'pending' && 'opacity-60')}
                        style={{ backgroundColor: e.leave_type_color }} title={`${e.employee_name} · ${e.leave_type_name}${e.half_day ? ' (half day)' : ''}${e.status === 'pending' ? ' · pending' : ''}`}>
                        {e.employee_name.split(' ')[0]}{e.half_day ? ' ½' : ''}
                      </span>
                    ))}
                    {!off && list.length > 3 && <span className="mt-1 block text-slate-500">+{list.length - 3} more</span>}
                  </div>
                );
              })}
            </div>
          </div>
          {/* phone: agenda list */}
          <ul className="space-y-2 sm:hidden" data-testid="leave-agenda">
            {entries.length === 0 && <li><EmptyState icon={<CalendarDays className="h-6 w-6" />} title="Nobody is on leave this month" /></li>}
            {entries.map((e) => (
              <li key={e.request_id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
                <span className="h-8 w-1.5 rounded-full" style={{ backgroundColor: e.leave_type_color }} />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{e.employee_name}</p>
                  <p className="text-xs text-slate-500">{e.leave_type_name} · {format(new Date(e.start_date), 'dd MMM')}{e.end_date !== e.start_date ? ` – ${format(new Date(e.end_date), 'dd MMM')}` : ''}{e.half_day ? ' · half day' : ''}</p></div>
                {e.status === 'pending' && <span className="text-[11px] font-medium text-amber-600">Pending</span>}
              </li>
            ))}
          </ul>
          {entries.length === 0 && <p className="mt-3 hidden text-center text-sm text-slate-500 sm:block">Nobody is on leave this month.</p>}
          <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-500">
            {[...new Map(entries.map((e) => [e.leave_type_name, e.leave_type_color])).entries()].map(([n, c]) => <span key={n} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded" style={{ backgroundColor: c }} />{n}</span>)}
            {entries.some((e) => e.status === 'pending') && <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-slate-400 opacity-60" />Pending (faded)</span>}
          </div>
        </>
      )}
    </Card>
  );
}
