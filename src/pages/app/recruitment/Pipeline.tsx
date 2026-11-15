import clsx from 'clsx';
import { CalendarClock, GripVertical, Star } from 'lucide-react';
import { useMemo, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Avatar, ErrorState, PageHeader, PageLoader, SearchInput, Select } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { MANUAL_STAGES, PIPELINE_COLUMNS, stageInfo } from '@/lib/constants';
import { fmtRelative } from '@/lib/format';
import { useAction, useDebounced, useList } from '@/lib/hooks';
import { useJobs } from '@/lib/lookups';
import { StageDialog } from './actions';
import type { Application } from './Candidates';

export function Pipeline() {
  const { companyId, can } = useCompany();
  const jobs = useJobs();
  const [jobId, setJobId] = useState('');
  const [search, setSearch] = useState('');
  const term = useDebounced(search);
  const [dragging, setDragging] = useState<Application | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Application | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const q = useList<Application>(companyId ? {
    table: 'v_applications',
    filters: [{ column: 'company_id', op: 'eq', value: companyId }, ...(jobId ? [{ column: 'job_id', op: 'eq' as const, value: jobId }] : [])],
    search: term ? { columns: ['candidate_name', 'candidate_email', 'job_title'], term } : undefined,
    order: [{ column: 'stage_changed_at', ascending: false }], range: [0, 999],
  } : null);
  const move = useAction(({ app, stage }: { app: Application; stage: string }) =>
    api.db.rpc('change_application_stage', { p_application: app.id, p_stage: stage, p_note: 'Moved on pipeline board' }),
    { success: (_r) => 'Stage updated' });

  const grouped = useMemo(() => {
    const g: Record<string, Application[]> = Object.fromEntries(PIPELINE_COLUMNS.map((c) => [c, []]));
    for (const a of q.data?.rows ?? []) (g[a.stage] ??= []).push(a);
    return g;
  }, [q.data]);
  const columns = PIPELINE_COLUMNS.filter((c) => showClosed || !['rejected'].includes(c));
  const manage = can('candidates.manage');

  const canDrop = (target: string, app: Application | null) => !!app && manage && app.stage !== target && MANUAL_STAGES.includes(target) && !['offered', 'hired'].includes(app.stage);
  const onDrop = (e: DragEvent, target: string) => {
    e.preventDefault();
    setOver(null);
    const app = dragging;
    setDragging(null);
    if (!app) return;
    if (!canDrop(target, app)) {
      if (['offered', 'hired'].includes(target)) toast.info('Offers and hiring are driven by the offer & onboarding workflow');
      else if (['offered', 'hired'].includes(app.stage)) toast.info('This candidate has an active offer — manage it from the Offers page');
      return;
    }
    if (target === 'rejected') setRejecting({ ...app, stage: app.stage });
    else move.mutate({ app, stage: target });
  };

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <PageHeader title="Recruitment pipeline" description="Drag candidates between stages. Candidate emails are sent automatically for key stage changes." />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select className="sm:w-72" value={jobId} onChange={(e) => setJobId(e.target.value)} options={jobs.options} placeholder="All jobs" aria-label="Filter by job" />
        <SearchInput className="sm:w-64" value={search} onChange={setSearch} placeholder="Search candidates" />
        <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" className="rounded border-slate-300" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show rejected</label>
        <span className="text-sm text-slate-500 sm:ml-auto">{q.data?.rows.length ?? 0} applications</span>
      </div>
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="scrollbar-thin -mx-4 flex flex-1 gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          {columns.map((col) => {
            const info = stageInfo(col);
            const items = grouped[col] ?? [];
            const droppable = dragging && canDrop(col, dragging);
            return (
              <section key={col} aria-label={`${info.label} column`}
                onDragOver={(e) => { if (droppable) { e.preventDefault(); setOver(col); } }}
                onDragLeave={() => setOver((o) => (o === col ? null : o))}
                onDrop={(e) => onDrop(e, col)}
                className={clsx('flex w-72 shrink-0 flex-col rounded-xl border bg-slate-100/70 transition',
                  over === col ? 'border-brand-400 bg-brand-50' : 'border-transparent', dragging && !droppable && 'opacity-60')}>
                <header className="flex items-center justify-between px-3 py-2.5">
                  <span className="flex items-center gap-2 text-sm font-semibold text-slate-700"><span className="h-2.5 w-2.5 rounded-full" style={{ background: info.color }} />{info.label}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-600">{items.length}</span>
                </header>
                <ul className="scrollbar-thin flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                  {items.length === 0 && <li className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">No candidates</li>}
                  {items.map((a) => (
                    <li key={a.id} draggable={manage && !['offered', 'hired'].includes(a.stage)}
                      onDragStart={(e) => { setDragging(a); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDragging(null); setOver(null); }}
                      className={clsx('group rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition hover:shadow-md', manage && 'cursor-grab active:cursor-grabbing', dragging?.id === a.id && 'opacity-40')}>
                      <div className="flex items-start gap-2.5">
                        <Avatar name={a.candidate_name} size="sm" />
                        <div className="min-w-0 flex-1">
                          <Link to={`/app/recruitment/candidates/${a.candidate_id}`} className="block truncate text-sm font-semibold text-slate-900 hover:underline">{a.candidate_name}</Link>
                          <p className="truncate text-xs text-slate-500">{a.job_title}</p>
                        </div>
                        {manage && <GripVertical className="h-4 w-4 shrink-0 text-slate-300 opacity-0 group-hover:opacity-100" aria-hidden />}
                      </div>
                      <div className="mt-2.5 flex items-center justify-between text-xs text-slate-500">
                        <span>{a.experience_years != null ? `${a.experience_years} yrs` : a.current_title ?? ''}</span>
                        <span className="flex items-center gap-2">
                          {a.interviews_count > 0 && <span className="flex items-center gap-0.5" title="Interviews"><CalendarClock className="h-3.5 w-3.5" />{a.interviews_count}</span>}
                          {(a.avg_feedback_rating || a.rating) && <span className="flex items-center gap-0.5 text-amber-600"><Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />{a.avg_feedback_rating ?? a.rating}</span>}
                          <span>{fmtRelative(a.stage_changed_at).replace('about ', '')}</span>
                        </span>
                      </div>
                      {manage && !['offered', 'hired'].includes(a.stage) && (
                        <select className="mt-2 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs md:hidden" value="" aria-label="Move to stage"
                          onChange={(e) => { const s = e.target.value; if (!s) return; if (s === 'rejected') setRejecting(a); else move.mutate({ app: a, stage: s }); }}>
                          <option value="">Move to…</option>
                          {MANUAL_STAGES.filter((s) => s !== a.stage).map((s) => <option key={s} value={s}>{stageInfo(s).label}</option>)}
                        </select>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {rejecting && <StageDialog open onClose={() => setRejecting(null)} applicationId={rejecting.id} current={rejecting.stage} initialStage="rejected" candidateName={`${rejecting.candidate_name} · ${rejecting.job_title}`} />}
    </div>
  );
}
