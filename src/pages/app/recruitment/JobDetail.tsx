import { ArrowLeft, Copy, ExternalLink, Pencil, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { Badge, Button, Card, ConfirmDialog, DescriptionList, ErrorState, PageHeader, PageLoader } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { STAGES, stageInfo } from '@/lib/constants';
import { fmtDate, fmtMoney, fmtRelative, titleCase } from '@/lib/format';
import { useAction, useList, useTable } from '@/lib/hooks';
import { BulkApplicationActions } from './BulkActions';
import { AddCandidateModal, type Application } from './Candidates';
import { JobForm, type Job } from './JobForm';

export function JobDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { company, can } = useCompany();
  const q = useList<Job>({ table: 'v_jobs', filters: [{ column: 'id', op: 'eq', value: id }], count: false });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const table = useTable({ table: 'v_applications', baseFilters: [{ column: 'job_id', op: 'eq', value: id }], searchColumns: ['candidate_name', 'candidate_email'], defaultSort: { column: 'applied_at', ascending: false } });
  const setStatus = useAction((status: string) => api.db.update('jobs', id, { status }), { success: (r) => `Job ${titleCase((r as { status: string }).status).toLowerCase()}` });
  const remove = useAction(() => api.db.remove('jobs', id), { success: 'Job deleted', onSuccess: () => navigate('/app/recruitment/jobs') });

  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const job = q.data?.rows[0];
  if (!job) return <ErrorState error="Job not found or you do not have access." />;
  const url = `${window.location.origin}/careers/${company?.slug}/jobs/${job.id}`;
  const canManage = can('jobs.manage');

  const columns: Column<Application>[] = [
    { key: 'candidate_name', header: 'Candidate', sortable: true, render: (a) => <div><p className="font-medium text-slate-900">{a.candidate_name}</p><p className="text-xs text-slate-500">{a.candidate_email}</p></div> },
    { key: 'stage', header: 'Stage', sortable: true, render: (a) => <Badge tone={stageInfo(a.stage).tone} dot>{stageInfo(a.stage).label}</Badge> },
    { key: 'experience_years', header: 'Exp.', hideOnMobile: true, render: (a) => (a.experience_years != null ? `${a.experience_years} yrs` : '—') },
    { key: 'avg_feedback_rating', header: 'Rating', hideOnMobile: true, render: (a) => (a.avg_feedback_rating ? `★ ${a.avg_feedback_rating}` : '—') },
    { key: 'applied_at', header: 'Applied', sortable: true, render: (a) => fmtRelative(a.applied_at) },
  ];

  return (
    <>
      <PageHeader breadcrumb={<Link to="/app/recruitment/jobs" className="inline-flex items-center gap-1 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Job openings</Link>}
        title={<span className="flex items-center gap-3">{job.title} <StatusBadge kind="job" value={job.status} /></span>}
        description={`${job.department_name ?? 'No department'} · ${job.location} · ${titleCase(job.work_mode)} · ${titleCase(job.employment_type)}`}
        actions={canManage && (
          <>
            {job.status !== 'published' && <Button variant="success" loading={setStatus.isPending} onClick={() => setStatus.mutate('published')}>Publish</Button>}
            {job.status === 'published' && <Button variant="secondary" loading={setStatus.isPending} onClick={() => setStatus.mutate('on_hold')}>Put on hold</Button>}
            {job.status !== 'closed' && <Button variant="secondary" onClick={() => setStatus.mutate('closed')}>Close</Button>}
            <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>
            {job.applications_count === 0 && <Button variant="ghost" aria-label="Delete job" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>}
          </>
        )} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[['Applicants', job.applications_count], ['Active', job.active_count], ['Hired', `${job.hired_count}/${job.openings}`], ['Posted', job.published_at ? fmtRelative(job.published_at) : 'Not yet']].map(([l, v]) => (
              <div key={l as string} className="card p-4"><p className="text-xs text-slate-500">{l}</p><p className="mt-1 text-lg font-semibold">{v}</p></div>
            ))}
          </div>
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="section-title">Applicants</h2>
              {can('candidates.manage') && job.status !== 'closed' && <Button size="sm" variant="secondary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add candidate</Button>}
            </div>
            <DataTable table={table} columns={columns} searchPlaceholder="Search applicants" onRowClick={(a) => navigate(`/app/recruitment/candidates/${a.candidate_id}`)}
              bulkActions={can('candidates.manage') ? (sel, clear) => <BulkApplicationActions selected={sel} clear={clear} /> : undefined}
              filters={[{ key: 'stage', label: 'Stages', options: STAGES.map((s) => ({ value: s.value, label: s.label })) }]}
              empty={{ title: 'No applicants yet', description: job.status === 'published' ? 'Share the careers link to start receiving applications.' : 'Publish this job to start receiving applications.' }} />
          </div>
        </div>
        <div className="space-y-5">
          {job.status === 'published' && (
            <Card title="Careers link">
              <p className="break-all rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{url}</p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" icon={<Copy className="h-4 w-4" />} onClick={() => navigator.clipboard.writeText(url).then(() => toast.success('Link copied'), () => toast.error('Could not copy link'))}>Copy</Button>
                <a href={url} target="_blank" rel="noreferrer" className="btn-secondary btn-sm"><ExternalLink className="h-4 w-4" /> Open</a>
              </div>
            </Card>
          )}
          <Card title="Details">
            <DescriptionList cols={1} items={[
              { label: 'Designation', value: job.designation_title },
              { label: 'Experience', value: `${job.experience_min}${job.experience_max ? `–${job.experience_max}` : '+'} years` },
              { label: 'Salary range', value: job.salary_min || job.salary_max ? `${fmtMoney(job.salary_min, company?.currency)} – ${fmtMoney(job.salary_max, company?.currency)} ${job.show_salary ? '(public)' : '(hidden)'}` : '—' },
              { label: 'Hiring manager', value: job.hiring_manager_name },
              { label: 'Closing date', value: fmtDate(job.closing_date) },
              { label: 'Skills', value: job.skills.length ? <div className="flex flex-wrap gap-1">{job.skills.map((s) => <Badge key={s}>{s}</Badge>)}</div> : '—' },
              { label: 'Requisition', value: job.requisition_id ? <Link className="text-brand-700 hover:underline" to="/app/recruitment/requisitions">Linked requisition</Link> : '—' },
            ]} />
          </Card>
          <Card title="Description"><p className="whitespace-pre-line text-sm text-slate-700">{job.description}</p></Card>
        </div>
      </div>
      {editing && <JobForm open job={job} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {adding && <AddCandidateModal open onClose={() => setAdding(false)} jobId={job.id} />}
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} title="Delete this job?" tone="danger" confirmLabel="Delete" loading={remove.isPending}
        message="This job has no applicants and will be permanently deleted." onConfirm={() => remove.mutate()} />
    </>
  );
}
