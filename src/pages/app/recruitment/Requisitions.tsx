import { CheckCircle2, ClipboardList, Pencil, Plus, Send, Trash2, XCircle, Briefcase } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { clean, FormModal, type FieldDef } from '@/components/FormModal';
import { Button, ConfirmDialog, PageHeader } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { EMPLOYMENT_TYPES, opts, PRIORITIES } from '@/lib/constants';
import { fmtDate, fmtMoney, titleCase } from '@/lib/format';
import { useAction, useTable } from '@/lib/hooks';
import { useDepartments, useDesignations } from '@/lib/lookups';
import { optDate, optId, optNum, optStr, reqNum, reqStr } from '@/lib/schemas';

export interface Requisition {
  id: string; company_id: string; title: string; department_id: string | null; department_name: string | null; designation_id: string | null;
  designation_title: string | null; headcount: number; employment_type: string; location: string | null; min_salary: number | null;
  max_salary: number | null; justification: string; priority: string; target_date: string | null; status: string; requested_by: string;
  requested_by_name: string | null; approved_by_name: string | null; approved_at: string | null; decision_note: string | null;
  jobs_count: number; created_at: string;
}

const schema = z.object({
  title: reqStr(3, 120, 'Title'),
  department_id: optId,
  designation_id: optId,
  headcount: reqNum(1, 500, 'Headcount is required'),
  employment_type: z.string(),
  location: optStr(120),
  min_salary: optNum(),
  max_salary: optNum(),
  priority: z.string(),
  target_date: optDate,
  justification: reqStr(10, 4000, 'Justification'),
}).refine((v) => v.min_salary == null || v.max_salary == null || v.max_salary >= v.min_salary, { message: 'Max must be ≥ min', path: ['max_salary'] });
type Values = z.infer<typeof schema>;

export function Requisitions() {
  const { companyId, company, can } = useCompany();
  const { user } = useSession();
  const navigate = useNavigate();
  const departments = useDepartments();
  const designations = useDesignations();
  const table = useTable({ table: 'v_requisitions', companyId, searchColumns: ['title', 'department_name', 'requested_by_name'], defaultSort: { column: 'created_at', ascending: false } });
  const [editing, setEditing] = useState<Requisition | null | 'new'>(null);
  const [deciding, setDeciding] = useState<{ r: Requisition; approve: boolean } | null>(null);
  const [deleting, setDeleting] = useState<Requisition | null>(null);

  const save = async (v: Values, submit = false) => {
    const data = clean({ ...v, company_id: companyId });
    if (editing === 'new') await api.db.insert('job_requisitions', { ...data, status: submit ? 'pending_approval' : 'draft' });
    else if (editing) await api.db.update('job_requisitions', editing.id, data);
  };
  const setStatus = useAction(({ id, status, note }: { id: string; status: string; note?: string }) =>
    api.db.update('job_requisitions', id, { status, ...(note !== undefined ? { decision_note: note || null } : {}) }), { success: 'Requisition updated' });
  const remove = useAction((id: string) => api.db.remove('job_requisitions', id), { success: 'Requisition deleted', onSuccess: () => setDeleting(null) });
  const saveAction = useAction((v: Values) => save(v), { success: editing === 'new' ? 'Requisition saved as draft' : 'Requisition updated' });

  const fields: FieldDef<Values>[] = [
    { name: 'title', label: 'Position title', required: true, span: 2 },
    { name: 'department_id', label: 'Department', type: 'select', options: departments.options },
    { name: 'designation_id', label: 'Designation', type: 'select', options: designations.options },
    { name: 'headcount', label: 'Headcount', type: 'number', required: true, min: 1 },
    { name: 'employment_type', label: 'Employment type', type: 'select', options: EMPLOYMENT_TYPES, required: true },
    { name: 'location', label: 'Location' },
    { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, required: true },
    { name: 'min_salary', label: `Budget min (${company?.currency}/yr)`, type: 'number', min: 0 },
    { name: 'max_salary', label: `Budget max (${company?.currency}/yr)`, type: 'number', min: 0 },
    { name: 'target_date', label: 'Target hire date', type: 'date' },
    { name: 'justification', label: 'Business justification', type: 'textarea', required: true },
  ];

  const canManage = can('requisitions.manage');
  const canApprove = can('requisitions.approve');
  const columns: Column<Requisition>[] = [
    { key: 'title', header: 'Position', sortable: true, render: (r) => (
      <div><p className="font-medium text-slate-900">{r.title}</p><p className="text-xs text-slate-500">{r.department_name ?? 'No department'} · {r.headcount} opening{r.headcount > 1 ? 's' : ''}</p></div>
    ) },
    { key: 'priority', header: 'Priority', sortable: true, render: (r) => <StatusBadge kind="priority" value={r.priority} /> },
    { key: 'budget', header: 'Budget', hideOnMobile: true, render: (r) => r.max_salary ? `${fmtMoney(r.min_salary, company?.currency, true)} – ${fmtMoney(r.max_salary, company?.currency, true)}` : '—', csv: (r) => `${r.min_salary ?? ''}-${r.max_salary ?? ''}` },
    { key: 'requested_by_name', header: 'Requested by', hideOnMobile: true, render: (r) => <span>{r.requested_by_name}<span className="block text-xs text-slate-500">{fmtDate(r.created_at)}</span></span> },
    { key: 'status', header: 'Status', sortable: true, render: (r) => <div><StatusBadge kind="requisition" value={r.status} />{r.decision_note && <p className="mt-1 max-w-[200px] truncate text-xs text-slate-500" title={r.decision_note}>{r.decision_note}</p>}</div> },
    { key: 'jobs_count', header: 'Jobs', hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader title="Job requisitions" description="Request new headcount, route it for approval and convert approved requisitions into job openings."
        actions={canManage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>New requisition</Button>} />
      <DataTable table={table} columns={columns} searchPlaceholder="Search requisitions" exportName="requisitions"
        filters={[{ key: 'status', label: 'Status', options: opts(['draft', 'pending_approval', 'approved', 'rejected', 'closed']) }, { key: 'priority', label: 'Priority', options: PRIORITIES }]}
        empty={{ icon: <ClipboardList className="h-6 w-6" />, title: 'No requisitions yet', description: 'Raise a requisition to request approval for a new hire.', action: canManage && <Button size="sm" onClick={() => setEditing('new')}>New requisition</Button> }}
        mobileCard={(r) => (
          <div className="flex items-start justify-between gap-2"><div><p className="font-medium">{r.title}</p><p className="text-xs text-slate-500">{r.department_name} · {titleCase(r.priority)}</p></div><StatusBadge kind="requisition" value={r.status} /></div>
        )}
        rowActions={(r) => (
          <div className="flex justify-end gap-1">
            {canManage && ['draft', 'rejected'].includes(r.status) && (r.requested_by === user?.id || canApprove) && (
              <>
                <Button variant="ghost" size="sm" title="Edit" aria-label="Edit" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
                <Button variant="ghost" size="sm" icon={<Send className="h-4 w-4" />} loading={setStatus.isPending} onClick={() => setStatus.mutate({ id: r.id, status: 'pending_approval' })}>Submit</Button>
                <Button variant="ghost" size="sm" aria-label="Delete" title="Delete" onClick={() => setDeleting(r)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>
              </>
            )}
            {canApprove && r.status === 'pending_approval' && (
              <>
                <Button variant="ghost" size="sm" icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />} onClick={() => setDeciding({ r, approve: true })}>Approve</Button>
                <Button variant="ghost" size="sm" icon={<XCircle className="h-4 w-4 text-rose-600" />} onClick={() => setDeciding({ r, approve: false })}>Reject</Button>
              </>
            )}
            {r.status === 'approved' && can('jobs.manage') && (
              <Button variant="secondary" size="sm" icon={<Briefcase className="h-4 w-4" />} onClick={() => navigate(`/app/recruitment/jobs?new=1&requisition=${r.id}`)}>Create job</Button>
            )}
            {r.status === 'approved' && canManage && (
              <Button variant="ghost" size="sm" onClick={() => setStatus.mutate({ id: r.id, status: 'closed' })}>Close</Button>
            )}
          </div>
        )} />

      <FormModal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'New requisition' : 'Edit requisition'}
        description="Requisitions are saved as drafts; submit them when ready for approval." schema={schema} fields={fields}
        submitLabel={editing === 'new' ? 'Save draft' : 'Save changes'}
        defaultValues={editing && editing !== 'new' ? { ...editing } as never : { employment_type: 'full_time', priority: 'medium', headcount: 1 } as never}
        onSubmit={(v) => saveAction.mutateAsync(v)} />
      <ConfirmDialog open={!!deciding} onClose={() => setDeciding(null)} loading={setStatus.isPending}
        title={deciding?.approve ? 'Approve requisition' : 'Reject requisition'} tone={deciding?.approve ? 'success' : 'danger'}
        confirmLabel={deciding?.approve ? 'Approve' : 'Reject'} message={deciding && <>“{deciding.r.title}” — {deciding.r.headcount} opening(s)</>}
        input={{ label: deciding?.approve ? 'Note (optional)' : 'Reason for rejection', required: !deciding?.approve, multiline: true }}
        onConfirm={(note) => deciding && setStatus.mutate({ id: deciding.r.id, status: deciding.approve ? 'approved' : 'rejected', note }, { onSuccess: () => setDeciding(null) })} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete requisition?" tone="danger" confirmLabel="Delete" loading={remove.isPending}
        message={`“${deleting?.title}” will be permanently deleted.`} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </>
  );
}
