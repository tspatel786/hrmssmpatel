import { Briefcase, ExternalLink, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { Badge, Button, PageHeader } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { opts, WORK_MODES } from '@/lib/constants';
import { fmtDate, titleCase } from '@/lib/format';
import { useRecord, useTable } from '@/lib/hooks';
import { useDepartments } from '@/lib/lookups';
import { JobForm, type Job } from './JobForm';
import type { Requisition } from './Requisitions';

export function Jobs() {
  const { companyId, company, can } = useCompany();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const departments = useDepartments();
  const [creating, setCreating] = useState(false);
  const reqId = params.get('requisition') ?? undefined;
  const requisition = useRecord<Requisition>('job_requisitions', reqId);
  useEffect(() => {
    if (params.get('new') === '1' && can('jobs.manage')) setCreating(true);
  }, [params, can]);
  const prefill = useMemo(() => requisition.data ? {
    requisition_id: requisition.data.id, title: requisition.data.title, department_id: requisition.data.department_id,
    designation_id: requisition.data.designation_id, openings: requisition.data.headcount, employment_type: requisition.data.employment_type,
    location: requisition.data.location ?? undefined, salary_min: requisition.data.min_salary, salary_max: requisition.data.max_salary,
    description: requisition.data.justification.length >= 20 ? requisition.data.justification : undefined,
  } : undefined, [requisition.data]);

  const table = useTable({ table: 'v_jobs', companyId, searchColumns: ['title', 'department_name', 'location'], defaultSort: { column: 'created_at', ascending: false } });
  const columns: Column<Job>[] = [
    { key: 'title', header: 'Job', sortable: true, render: (j) => (
      <div><p className="font-medium text-slate-900">{j.title}</p><p className="text-xs text-slate-500">{j.department_name ?? '—'} · {j.location} · {titleCase(j.work_mode)}</p></div>
    ) },
    { key: 'status', header: 'Status', sortable: true, render: (j) => <StatusBadge kind="job" value={j.status} /> },
    { key: 'applications_count', header: 'Applicants', sortable: true, render: (j) => (
      <span className="flex items-center gap-2"><span className="font-semibold">{j.applications_count}</span>{j.active_count > 0 && <Badge tone="blue">{j.active_count} active</Badge>}</span>
    ) },
    { key: 'openings', header: 'Openings', hideOnMobile: true, render: (j) => `${j.hired_count}/${j.openings} filled` },
    { key: 'hiring_manager_name', header: 'Hiring manager', hideOnMobile: true, render: (j) => j.hiring_manager_name ?? '—' },
    { key: 'published_at', header: 'Published', sortable: true, hideOnMobile: true, render: (j) => fmtDate(j.published_at) },
  ];
  const closeForm = () => {
    setCreating(false);
    if (params.get('new')) setParams({}, { replace: true });
  };
  return (
    <>
      <PageHeader title="Job openings" description="Create, publish and track job openings on your careers page."
        actions={
          <>
            {company?.careers_enabled && <a className="btn-secondary" href={`/careers/${company.slug}`} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /> View careers page</a>}
            {can('jobs.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New job</Button>}
          </>
        } />
      <DataTable table={table} columns={columns} searchPlaceholder="Search jobs" exportName="jobs" onRowClick={(j) => navigate(`/app/recruitment/jobs/${j.id}`)}
        filters={[
          { key: 'status', label: 'Status', options: opts(['draft', 'published', 'on_hold', 'closed']) },
          { key: 'department_id', label: 'Departments', options: departments.options },
          { key: 'work_mode', label: 'Work modes', options: WORK_MODES },
        ]}
        mobileCard={(j) => (
          <div className="flex items-start justify-between gap-2"><div><p className="font-medium">{j.title}</p><p className="text-xs text-slate-500">{j.location} · {j.applications_count} applicants</p></div><StatusBadge kind="job" value={j.status} /></div>
        )}
        empty={{ icon: <Briefcase className="h-6 w-6" />, title: 'No job openings yet', description: 'Create your first job and publish it to your careers page.', action: can('jobs.manage') && <Button size="sm" onClick={() => setCreating(true)}>New job</Button> }} />
      {creating && (!reqId || requisition.data) && (
        <JobForm open onClose={closeForm} prefill={prefill} onSaved={(id) => { closeForm(); navigate(`/app/recruitment/jobs/${id}`); }} />
      )}
    </>
  );
}
