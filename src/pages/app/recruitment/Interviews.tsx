import { addDays, addMonths, addWeeks, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import clsx from 'clsx';
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, MapPin, Users, Video } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/DataTable';
import { Badge, Button, DescriptionList, Drawer, EmptyState, ErrorState, PageHeader, PageLoader, Select, Tabs } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { fmtDateTime, fmtTime, titleCase } from '@/lib/format';
import { useAction, useList } from '@/lib/hooks';
import { CancelInterviewDialog, FeedbackModal, ScheduleInterviewModal } from './actions';

interface Iv {
  id: string; company_id: string; application_id: string; round_name: string; interview_type: string; scheduled_at: string; ends_at: string;
  duration_minutes: number; location: string | null; meeting_link: string | null; status: string; notes: string | null; candidate_id: string;
  candidate_name: string; candidate_email: string; job_title: string; panelists: { id: string; name: string; email: string }[];
  panelist_ids: string[] | null; feedback_count: number; application_stage: string;
}
interface MyFb { id: string; interview_id: string; overall_rating: number; technical_rating: number | null; communication_rating: number | null; culture_rating: number | null; recommendation: string; strengths: string | null; weaknesses: string | null; comments: string | null }

const COLORS: Record<string, string> = { scheduled: 'bg-blue-50 text-blue-800 border-blue-200', completed: 'bg-emerald-50 text-emerald-800 border-emerald-200', cancelled: 'bg-slate-50 text-slate-400 border-slate-200 line-through', no_show: 'bg-orange-50 text-orange-800 border-orange-200' };
const HOURS = Array.from({ length: 13 }, (_, i) => i + 8);

export function Interviews() {
  const { companyId, can } = useCompany();
  const { user } = useSession();
  const [view, setView] = useState<'month' | 'week' | 'list'>(() => (typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : 'month'));
  const [cursor, setCursor] = useState(new Date());
  const [mine, setMine] = useState(!can('interviews.view'));
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<Iv | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<Iv | null>(null);
  const [rescheduling, setRescheduling] = useState<Iv | null>(null);
  const [cancelling, setCancelling] = useState<Iv | null>(null);

  const range = useMemo(() => {
    if (view === 'month') return [startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 })];
    if (view === 'week') return [startOfWeek(cursor, { weekStartsOn: 1 }), endOfWeek(cursor, { weekStartsOn: 1 })];
    return [addDays(new Date(), -30), addDays(new Date(), 60)];
  }, [view, cursor]);

  const q = useList<Iv>(companyId ? {
    table: 'v_interviews',
    filters: [
      { column: 'company_id', op: 'eq', value: companyId },
      { column: 'scheduled_at', op: 'gte', value: range[0].toISOString() },
      { column: 'scheduled_at', op: 'lte', value: range[1].toISOString() },
      ...(status ? [{ column: 'status', op: 'eq' as const, value: status }] : []),
      ...(mine && user ? [{ column: 'panelist_ids', op: 'contains' as const, value: [user.id] }] : []),
    ],
    order: [{ column: 'scheduled_at', ascending: true }], range: [0, 999],
  } : null);
  const myFb = useList<MyFb>(user ? { table: 'interview_feedback', filters: [{ column: 'interviewer_id', op: 'eq', value: user.id }], range: [0, 999] } : null);
  const setIvStatus = useAction(({ id, s }: { id: string; s: string }) => api.db.rpc('set_interview_status', { p_interview: id, p_status: s }), { success: 'Interview updated', onSuccess: () => setSelected(null) });

  const items = q.data?.rows ?? [];
  const byDay = (d: Date) => items.filter((i) => isSameDay(new Date(i.scheduled_at), d));
  const step = (dir: number) => setCursor((c) => (view === 'month' ? addMonths(c, dir) : addWeeks(c, dir)));
  const title = view === 'month' ? format(cursor, 'MMMM yyyy') : view === 'week' ? `${format(range[0], 'dd MMM')} – ${format(range[1], 'dd MMM yyyy')}` : 'Upcoming & recent (90 days)';
  const myFeedbackFor = (id: string) => myFb.data?.rows.find((f) => f.interview_id === id) ?? null;
  const isPanel = (i: Iv) => (i.panelist_ids ?? []).includes(user?.id ?? '');
  const manage = can('interviews.manage');

  const Event = ({ i, compact }: { i: Iv; compact?: boolean }) => (
    <button type="button" onClick={() => setSelected(i)} className={clsx('w-full truncate rounded-md border px-1.5 py-0.5 text-left text-[11px] font-medium', COLORS[i.status])}
      title={`${fmtTime(i.scheduled_at)} ${i.candidate_name} · ${i.round_name}`}>
      {!compact && <span className="mr-1 opacity-70">{fmtTime(i.scheduled_at)}</span>}{i.candidate_name}
    </button>
  );

  return (
    <>
      <PageHeader title="Interviews" description="Interview calendar for your team. Click an interview to view details, reschedule or submit feedback." />
      <div className="card mb-4 flex flex-col gap-3 p-3 lg:flex-row lg:items-center">
        <div className="flex items-center gap-1">
          {view !== 'list' && <>
            <Button variant="ghost" size="sm" aria-label="Previous" onClick={() => step(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="secondary" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
            <Button variant="ghost" size="sm" aria-label="Next" onClick={() => step(1)}><ChevronRight className="h-4 w-4" /></Button>
          </>}
          <h2 className="ml-2 text-base font-semibold">{title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          {can('interviews.view') && (
            <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" className="rounded border-slate-300" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my interviews</label>
          )}
          <Select className="w-auto py-1.5" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" aria-label="Status"
            options={['scheduled', 'completed', 'cancelled', 'no_show'].map((s) => ({ value: s, label: titleCase(s) }))} />
          <Tabs className="border-0" value={view} onChange={setView} tabs={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'list', label: 'List' }]} />
        </div>
      </div>

      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : view === 'month' ? (
        <div className="card overflow-hidden">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-semibold uppercase text-slate-500">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {Array.from({ length: Math.round((range[1].getTime() - range[0].getTime()) / 86400000) }, (_, k) => addDays(range[0], k)).map((d) => {
              const ev = byDay(d);
              return (
                <div key={d.toISOString()} className={clsx('min-h-[96px] border-b border-r border-slate-100 p-1.5', !isSameMonth(d, cursor) && 'bg-slate-50/60')}>
                  <div className={clsx('mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs', isSameDay(d, new Date()) ? 'bg-brand-500 font-semibold text-ink' : isSameMonth(d, cursor) ? 'text-slate-700' : 'text-slate-400')}>{format(d, 'd')}</div>
                  <div className="space-y-1">
                    {ev.slice(0, 3).map((i) => <Event key={i.id} i={i} />)}
                    {ev.length > 3 && <button type="button" className="text-[11px] font-medium text-brand-700" onClick={() => { setCursor(d); setView('week'); }}>+{ev.length - 3} more</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : view === 'week' ? (
        <div className="card overflow-x-auto">
          <div className="grid min-w-[760px] grid-cols-[56px_repeat(7,1fr)]">
            <div className="border-b border-slate-200" />
            {Array.from({ length: 7 }, (_, k) => addDays(range[0], k)).map((d) => (
              <div key={d.toISOString()} className={clsx('border-b border-l border-slate-200 py-2 text-center text-xs', isSameDay(d, new Date()) && 'bg-brand-50')}>
                <p className="font-semibold uppercase text-slate-500">{format(d, 'EEE')}</p><p className="text-base font-semibold text-slate-800">{format(d, 'd')}</p>
              </div>
            ))}
            {HOURS.map((h) => (
              <div key={h} className="contents">
                <div className="h-14 border-b border-slate-100 pr-2 pt-1 text-right text-[11px] text-slate-400">{format(new Date(2000, 0, 1, h), 'h a')}</div>
                {Array.from({ length: 7 }, (_, k) => addDays(range[0], k)).map((d) => {
                  const ev = byDay(d).filter((i) => { const hr = new Date(i.scheduled_at).getHours(); return hr === h || (h === 8 && hr < 8) || (h === 20 && hr > 20); });
                  return <div key={d.toISOString()} className="h-14 space-y-0.5 border-b border-l border-slate-100 p-0.5">{ev.map((i) => <Event key={i.id} i={i} />)}</div>;
                })}
              </div>
            ))}
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="card"><EmptyState icon={<CalendarDays className="h-6 w-6" />} title="No interviews" description="Interviews you schedule from a candidate profile appear here." /></div>
      ) : (
        <div className="card divide-y divide-slate-100">
          {items.map((i) => (
            <button key={i.id} type="button" onClick={() => setSelected(i)} className="flex w-full flex-col gap-2 p-4 text-left hover:bg-slate-50 sm:flex-row sm:items-center">
              <div className="w-28 shrink-0 text-sm"><p className="font-semibold">{format(new Date(i.scheduled_at), 'EEE, dd MMM')}</p><p className="text-slate-500">{fmtTime(i.scheduled_at)}</p></div>
              <div className="min-w-0 flex-1"><p className="font-medium">{i.candidate_name} <span className="font-normal text-slate-500">· {i.round_name}</span></p><p className="truncate text-sm text-slate-500">{i.job_title} · {i.panelists.map((p) => p.name).join(', ')}</p></div>
              <div className="flex items-center gap-2">
                {isPanel(i) && !myFeedbackFor(i.id) && i.status !== 'cancelled' && new Date(i.scheduled_at) < new Date() && <Badge tone="yellow">Feedback due</Badge>}
                <StatusBadge kind="interview" value={i.status} />
              </div>
            </button>
          ))}
        </div>
      )}

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected ? `${selected.round_name} · ${selected.candidate_name}` : ''}
        footer={selected && (
          <div className="flex flex-wrap justify-end gap-2">
            {manage && selected.status === 'scheduled' && <>
              <Button variant="ghost" className="text-rose-600" onClick={() => setCancelling(selected)}>Cancel</Button>
              <Button variant="secondary" onClick={() => setIvStatus.mutate({ id: selected.id, s: 'no_show' })}>No-show</Button>
              <Button variant="secondary" onClick={() => setRescheduling(selected)}>Reschedule</Button>
            </>}
            {(isPanel(selected) || manage) && selected.status !== 'cancelled' && new Date(selected.scheduled_at).getTime() <= Date.now() + 15 * 60000 && (
              <Button onClick={() => setFeedbackFor(selected)}>{myFeedbackFor(selected.id) ? 'Edit my feedback' : 'Submit feedback'}</Button>
            )}
          </div>
        )}>
        {selected && (
          <div className="space-y-5">
            <div className="flex items-center gap-2"><StatusBadge kind="interview" value={selected.status} /><Badge>{titleCase(selected.interview_type)}</Badge></div>
            <DescriptionList cols={1} items={[
              { label: 'Candidate', value: <Link to={`/app/recruitment/candidates/${selected.candidate_id}`} className="font-medium text-brand-700 hover:underline">{selected.candidate_name}</Link> },
              { label: 'Job', value: selected.job_title },
              { label: 'When', value: `${fmtDateTime(selected.scheduled_at)} – ${fmtTime(selected.ends_at)} (${selected.duration_minutes} min)` },
              { label: 'Meeting link', value: selected.meeting_link ? <a href={selected.meeting_link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline"><Video className="h-4 w-4" /> Join meeting <ExternalLink className="h-3 w-3" /></a> : '—' },
              { label: 'Location', value: selected.location ? <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" />{selected.location}</span> : '—' },
              { label: 'Panel', value: <span className="inline-flex items-center gap-1"><Users className="h-4 w-4" />{selected.panelists.map((p) => p.name).join(', ')}</span> },
              { label: 'Feedback received', value: `${selected.feedback_count} of ${selected.panelists.length}` },
              { label: 'Notes', value: selected.notes ? <span className="whitespace-pre-line">{selected.notes}</span> : '—' },
            ]} />
          </div>
        )}
      </Drawer>
      {feedbackFor && <FeedbackModal open onClose={() => setFeedbackFor(null)} interviewId={feedbackFor.id} title={`${feedbackFor.candidate_name} · ${feedbackFor.round_name}`} existing={myFeedbackFor(feedbackFor.id)} />}
      {rescheduling && <ScheduleInterviewModal open onClose={() => { setRescheduling(null); setSelected(null); }} interview={rescheduling} candidateName={rescheduling.candidate_name} />}
      {cancelling && <CancelInterviewDialog open onClose={() => { setCancelling(null); setSelected(null); }} interviewId={cancelling.id} />}
    </>
  );
}
