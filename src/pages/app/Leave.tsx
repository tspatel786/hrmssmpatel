import { format } from 'date-fns';
import { CheckCircle2, Pencil, Plane, Plus, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { FormModal, type FieldDef } from '@/components/FormModal';
import { Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, Modal, PageHeader, PageLoader, Select, Tabs } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { opts } from '@/lib/constants';
import { fmtDate, fmtRelative } from '@/lib/format';
import { useAction, useList, useRpc, useTable } from '@/lib/hooks';
import { useEmployeeOptions, useLeaveTypes } from '@/lib/lookups';
import { reqDate, reqNum, reqStr } from '@/lib/schemas';

interface Req { id: string; employee_id: string; employee_name: string; employee_code: string; leave_type_id: string; leave_type_name: string; leave_type_color: string; is_paid: boolean; start_date: string; end_date: string; half_day: boolean; days: number; reason: string; status: string; approver_name: string | null; decided_at: string | null; decision_note: string | null; created_at: string; manager_id: string | null; department_name: string | null }
interface Bal { id: string; employee_id: string; employee_name: string; employee_code: string; leave_type_id: string; leave_type_name: string; leave_type_color: string; year: number; allocated: number; used: number; available: number }
interface LType { id: string; name: string; code: string; annual_quota: number; is_paid: boolean; carry_forward: boolean; color: string; is_active: boolean }

const applySchema = z.object({
  employee_id: z.string().optional().nullable(),
  leave_type_id: reqStr(1, 50, 'Leave type'),
  start_date: reqDate('Start date'),
  end_date: reqDate('End date'),
  half_day: z.boolean().default(false),
  reason: reqStr(3, 1000, 'Reason'),
}).refine((v) => v.end_date >= v.start_date, { message: 'End date must be on or after start date', path: ['end_date'] })
  .refine((v) => !v.half_day || v.start_date === v.end_date, { message: 'Half day must be a single day', path: ['half_day'] });

export function ApplyLeaveModal({ open, onClose, forOthers }: { open: boolean; onClose: () => void; forOthers?: boolean }) {
  const { companyId } = useCompany();
  const types = useLeaveTypes();
  const emps = useEmployeeOptions();
  const apply = useAction((v: z.infer<typeof applySchema>) => api.db.rpc('apply_leave', { p_company: companyId, p_employee: v.employee_id || null, p_type: v.leave_type_id, p_start: v.start_date, p_end: v.end_date, p_half_day: v.half_day, p_reason: v.reason }),
    { success: 'Leave request submitted for approval', silent: true });
  const fields: FieldDef<z.infer<typeof applySchema>>[] = [
    { name: 'employee_id', label: 'Employee', type: 'select', options: emps.options, hidden: !forOthers, required: forOthers, span: 2 },
    { name: 'leave_type_id', label: 'Leave type', type: 'select', options: types.options, required: true, span: 2 },
    { name: 'start_date', label: 'From', type: 'date', required: true },
    { name: 'end_date', label: 'To', type: 'date', required: true },
    { name: 'half_day', label: 'Half day', type: 'checkbox', span: 2 },
    { name: 'reason', label: 'Reason', type: 'textarea', required: true, rows: 3 },
  ];
  const today = format(new Date(), 'yyyy-MM-dd');
  return (
    <FormModal open={open} onClose={onClose} title={forOthers ? 'Apply leave on behalf' : 'Apply for leave'} size="md" schema={applySchema} fields={fields}
      description="Weekends and company holidays are excluded automatically." submitLabel="Submit request"
      defaultValues={{ start_date: today, end_date: today, half_day: false } as never} onSubmit={(v) => apply.mutateAsync(v)} />
  );
}

function DecideButtons({ r, onDecide }: { r: Req; onDecide: (r: Req, approve: boolean) => void }) {
  return (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant="ghost" icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />} onClick={() => onDecide(r, true)}>Approve</Button>
      <Button size="sm" variant="ghost" icon={<XCircle className="h-4 w-4 text-rose-600" />} onClick={() => onDecide(r, false)}>Reject</Button>
    </div>
  );
}

const reqColumns: Column<Req>[] = [
  { key: 'employee_name', header: 'Employee', sortable: true, render: (r) => <div className="flex items-center gap-2"><Avatar name={r.employee_name} size="xs" /><span><span className="font-medium">{r.employee_name}</span><span className="block text-xs text-slate-500">{r.employee_code}</span></span></div> },
  { key: 'leave_type_name', header: 'Type', render: (r) => <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: r.leave_type_color }} />{r.leave_type_name}</span> },
  { key: 'start_date', header: 'Dates', sortable: true, render: (r) => <span>{fmtDate(r.start_date, 'dd MMM')}{r.end_date !== r.start_date && ` – ${fmtDate(r.end_date, 'dd MMM yyyy')}`}{r.end_date === r.start_date && fmtDate(r.start_date, ' yyyy')}</span>, csv: (r) => `${r.start_date} to ${r.end_date}` },
  { key: 'days', header: 'Days', sortable: true, render: (r) => `${r.days}${r.half_day ? ' (half)' : ''}` },
  { key: 'reason', header: 'Reason', hideOnMobile: true, render: (r) => <span className="line-clamp-1 max-w-[220px]" title={r.reason}>{r.reason}</span> },
  { key: 'status', header: 'Status', sortable: true, render: (r) => <div><StatusBadge kind="leave" value={r.status} />{r.approver_name && <p className="mt-0.5 text-xs text-slate-500">by {r.approver_name}</p>}</div> },
];

function MyLeave({ companyId, employeeId }: { companyId: string; employeeId: string }) {
  const [applying, setApplying] = useState(false);
  const [cancelling, setCancelling] = useState<Req | null>(null);
  const year = new Date().getFullYear();
  const bal = useList<Bal>({ table: 'v_leave_balances', filters: [{ column: 'employee_id', op: 'eq', value: employeeId }, { column: 'year', op: 'eq', value: year }] });
  const table = useTable({ table: 'v_leave_requests', companyId, baseFilters: [{ column: 'employee_id', op: 'eq', value: employeeId }], defaultSort: { column: 'start_date', ascending: false } });
  const cancel = useAction((id: string) => api.db.rpc('cancel_leave', { p_request: id }), { success: 'Leave cancelled', onSuccess: () => setCancelling(null) });
  return (
    <div className="space-y-5">
      <div className="flex justify-end"><Button icon={<Plus className="h-4 w-4" />} onClick={() => setApplying(true)}>Apply leave</Button></div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(bal.data?.rows ?? []).length === 0 && !bal.isLoading && <div className="card sm:col-span-4"><EmptyState title={`No leave balances for ${year}`} description="Ask HR to allocate your leave balances." /></div>}
        {(bal.data?.rows ?? []).map((b) => (
          <div key={b.id} className="card p-5">
            <p className="flex items-center gap-2 text-sm font-medium text-slate-600"><span className="h-2.5 w-2.5 rounded-full" style={{ background: b.leave_type_color }} />{b.leave_type_name}</p>
            <p className="mt-2 text-3xl font-semibold">{b.available}<span className="text-sm font-normal text-slate-500"> days left</span></p>
            <div className="mt-3 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full" style={{ width: `${b.allocated ? (b.used / b.allocated) * 100 : 0}%`, background: b.leave_type_color }} /></div>
            <p className="mt-1.5 text-xs text-slate-500">{b.used} used of {b.allocated}</p>
          </div>
        ))}
      </div>
      <DataTable table={table} columns={reqColumns.filter((c) => c.key !== 'employee_name')} exportName="my-leave"
        filters={[{ key: 'status', label: 'Status', options: opts(['pending', 'approved', 'rejected', 'cancelled']) }]}
        rowActions={(r) => ['pending', 'approved'].includes(r.status) && (r.status === 'pending' || r.start_date > format(new Date(), 'yyyy-MM-dd')) ? <Button size="sm" variant="ghost" onClick={() => setCancelling(r)}>Cancel</Button> : null}
        empty={{ icon: <Plane className="h-6 w-6" />, title: 'No leave requests', description: 'Your leave history will appear here.' }} />
      {applying && <ApplyLeaveModal open onClose={() => setApplying(false)} />}
      <ConfirmDialog open={!!cancelling} onClose={() => setCancelling(null)} title="Cancel this leave request?" tone="danger" confirmLabel="Cancel leave" loading={cancel.isPending}
        message={cancelling?.status === 'approved' ? 'Your balance will be restored.' : undefined} onConfirm={() => cancelling && cancel.mutate(cancelling.id)} />
    </div>
  );
}

function Approvals({ companyId, myEmployeeId }: { companyId: string; myEmployeeId?: string }) {
  const table = useTable({ table: 'v_leave_requests', companyId, baseFilters: [{ column: 'status', op: 'eq', value: 'pending' }, ...(myEmployeeId ? [{ column: 'employee_id', op: 'neq' as const, value: myEmployeeId }] : [])], searchColumns: ['employee_name', 'employee_code'], defaultSort: { column: 'start_date' } });
  const [deciding, setDeciding] = useState<{ r: Req; approve: boolean } | null>(null);
  const decide = useAction(({ id, approve, note }: { id: string; approve: boolean; note: string }) => api.db.rpc('decide_leave', { p_request: id, p_approve: approve, p_note: note || null }),
    { success: 'Decision saved · employee notified', onSuccess: () => setDeciding(null) });
  return (
    <>
      <DataTable table={table} columns={[...reqColumns.filter((c) => c.key !== 'status'), { key: 'created_at', header: 'Requested', hideOnMobile: true, render: (r) => fmtRelative(r.created_at) }]}
        searchPlaceholder="Search employee" rowActions={(r) => <DecideButtons r={r} onDecide={(rr, approve) => setDeciding({ r: rr, approve })} />}
        empty={{ icon: <CheckCircle2 className="h-6 w-6" />, title: 'No pending approvals', description: 'You are all caught up.' }} />
      <ConfirmDialog open={!!deciding} onClose={() => setDeciding(null)} loading={decide.isPending} tone={deciding?.approve ? 'success' : 'danger'}
        title={deciding?.approve ? 'Approve leave' : 'Reject leave'} confirmLabel={deciding?.approve ? 'Approve' : 'Reject'}
        message={deciding && <>{deciding.r.employee_name} · {deciding.r.leave_type_name} · {deciding.r.days} day(s)<br /><span className="text-slate-500">“{deciding.r.reason}”</span></>}
        input={{ label: deciding?.approve ? 'Note (optional)' : 'Reason', required: !deciding?.approve }} onConfirm={(note) => deciding && decide.mutate({ id: deciding.r.id, approve: deciding.approve, note })} />
    </>
  );
}

function AllRequests({ companyId }: { companyId: string }) {
  const { can } = useCompany();
  const types = useLeaveTypes();
  const [applying, setApplying] = useState(false);
  const table = useTable({ table: 'v_leave_requests', companyId, searchColumns: ['employee_name', 'employee_code', 'reason'], defaultSort: { column: 'start_date', ascending: false } });
  const cancel = useAction((id: string) => api.db.rpc('cancel_leave', { p_request: id }), { success: 'Leave cancelled' });
  return (
    <>
      <DataTable table={table} columns={reqColumns} searchPlaceholder="Search employee or reason" exportName="leave-requests"
        toolbar={can('leave.manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setApplying(true)}>Apply on behalf</Button>}
        filters={[{ key: 'status', label: 'Status', options: opts(['pending', 'approved', 'rejected', 'cancelled']) }, { key: 'leave_type_id', label: 'Types', options: types.options }]}
        rowActions={can('leave.manage') ? (r) => (['pending', 'approved'].includes(r.status) ? <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>Cancel</Button> : null) : undefined}
        empty={{ title: 'No leave requests' }} />
      {applying && <ApplyLeaveModal open onClose={() => setApplying(false)} forOthers />}
    </>
  );
}

function Balances({ companyId }: { companyId: string }) {
  const { can } = useCompany();
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [editing, setEditing] = useState<Bal | null>(null);
  const [allocated, setAllocated] = useState('');
  const types = useLeaveTypes();
  const table = useTable({ table: 'v_leave_balances', companyId, baseFilters: [{ column: 'year', op: 'eq', value: Number(year) }], searchColumns: ['employee_name', 'employee_code'], defaultSort: { column: 'employee_code' } });
  const allocate = useAction(() => api.db.rpc<number>('allocate_leave_balances', { p_company: companyId, p_year: Number(year) }), { success: (n) => (n ? `Allocated ${n} new balance(s)` : 'All employees already have balances for this year') });
  const save = useAction(() => {
    const n = Number(allocated);
    if (Number.isNaN(n) || n < editing!.used || n > 365) throw new Error(`Allocation must be between ${editing!.used} (used) and 365`);
    return api.db.update('leave_balances', editing!.id, { allocated: n });
  }, { success: 'Balance updated', onSuccess: () => setEditing(null) });
  const manage = can('leave.manage');
  const columns: Column<Bal>[] = [
    { key: 'employee_name', header: 'Employee', sortable: true, render: (b) => <span><span className="font-medium">{b.employee_name}</span> <span className="text-xs text-slate-400">{b.employee_code}</span></span> },
    { key: 'leave_type_name', header: 'Type', render: (b) => <Badge><span className="h-2 w-2 rounded-full" style={{ background: b.leave_type_color }} />{b.leave_type_name}</Badge> },
    { key: 'allocated', header: 'Allocated', sortable: true }, { key: 'used', header: 'Used', sortable: true },
    { key: 'available', header: 'Available', render: (b) => <span className="font-semibold">{b.available}</span> },
  ];
  return (
    <>
      <DataTable table={table} columns={columns} searchPlaceholder="Search employee" exportName={`leave-balances-${year}`}
        filters={[{ key: 'leave_type_id', label: 'Types', options: types.options }]}
        toolbar={<>
          <Select className="w-auto py-1.5" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year" options={[-1, 0, 1].map((d) => String(new Date().getFullYear() + d)).map((y) => ({ value: y, label: y }))} />
          {manage && <Button size="sm" variant="secondary" loading={allocate.isPending} onClick={() => allocate.mutate()}>Allocate {year}</Button>}
        </>}
        rowActions={manage ? (b) => <Button size="sm" variant="ghost" aria-label="Edit balance" onClick={() => { setEditing(b); setAllocated(String(b.allocated)); }}><Pencil className="h-4 w-4" /></Button> : undefined}
        empty={{ title: `No balances for ${year}`, description: manage ? 'Use “Allocate” to create balances for all active employees from leave type quotas (with carry-forward).' : undefined }} />
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Adjust balance" description={editing ? `${editing.employee_name} · ${editing.leave_type_name} ${editing.year}` : ''} size="sm"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <Field label="Allocated days" hint={editing ? `${editing.used} day(s) already used` : undefined}><Input type="number" step="0.5" min={0} value={allocated} onChange={(e) => setAllocated(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

const typeSchema = z.object({ name: reqStr(2, 60, 'Name'), code: reqStr(1, 10, 'Code'), annual_quota: reqNum(0, 365, 'Required'), is_paid: z.boolean(), carry_forward: z.boolean(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), is_active: z.boolean() });
function LeaveTypes({ companyId }: { companyId: string }) {
  const q = useList<LType>({ table: 'leave_types', filters: [{ column: 'company_id', op: 'eq', value: companyId }], order: [{ column: 'name' }] });
  const [editing, setEditing] = useState<LType | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LType | null>(null);
  const save = useAction((v: z.infer<typeof typeSchema>) => (editing === 'new' ? api.db.insert('leave_types', { ...v, code: v.code.toUpperCase(), company_id: companyId }) : api.db.update('leave_types', (editing as LType).id, { ...v, code: v.code.toUpperCase() })), { success: 'Leave type saved' });
  const remove = useAction((id: string) => api.db.remove('leave_types', id), { success: 'Leave type deleted', onSuccess: () => setDeleting(null) });
  const fields: FieldDef<z.infer<typeof typeSchema>>[] = [
    { name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code', required: true },
    { name: 'annual_quota', label: 'Annual quota (days)', type: 'number', required: true, step: '0.5' }, { name: 'color', label: 'Color', type: 'color' },
    { name: 'is_paid', label: 'Paid leave', type: 'checkbox', hint: 'Unpaid leave is deducted as loss of pay in payroll' }, { name: 'carry_forward', label: 'Carry forward unused days', type: 'checkbox' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ];
  return (
    <Card title="Leave types" padded={false} actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Add type</Button>}>
      {q.isLoading ? <PageLoader /> : (
        <div className="overflow-x-auto"><table className="table"><thead><tr><th>Type</th><th>Code</th><th>Quota</th><th>Paid</th><th>Carry forward</th><th>Status</th><th /></tr></thead><tbody>
          {(q.data?.rows ?? []).map((t) => (
            <tr key={t.id}><td><span className="flex items-center gap-2 font-medium"><span className="h-3 w-3 rounded-full" style={{ background: t.color }} />{t.name}</span></td><td>{t.code}</td><td>{t.annual_quota} days</td><td>{t.is_paid ? 'Yes' : 'No (LOP)'}</td><td>{t.carry_forward ? 'Yes' : 'No'}</td><td>{t.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
              <td className="text-right"><Button size="sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(t)}><Pencil className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label="Delete" onClick={() => setDeleting(t)}><Trash2 className="h-4 w-4 text-rose-500" /></Button></td></tr>
          ))}
        </tbody></table></div>
      )}
      <FormModal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add leave type' : 'Edit leave type'} size="md" schema={typeSchema} fields={fields}
        defaultValues={(editing && editing !== 'new' ? editing : { is_paid: true, carry_forward: false, is_active: true, color: '#2549eb', annual_quota: 0 }) as never} onSubmit={(v) => save.mutateAsync(v)} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete leave type?" tone="danger" confirmLabel="Delete" loading={remove.isPending}
        message="Types already used in requests cannot be deleted — deactivate them instead." onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </Card>
  );
}

type TabKey = 'mine' | 'approvals' | 'all' | 'balances' | 'types';
export function Leave() {
  const { companyId, can } = useCompany();
  const [params, setParams] = useSearchParams();
  const me = useRpc<{ employee: { id: string } | null; team_pending_leave: number }>('my_dashboard', companyId ? { p_company: companyId } : null);
  const employeeId = me.data?.employee?.id;
  const isManager = (me.data?.team_pending_leave ?? 0) > 0;
  const tabs: { value: TabKey; label: string }[] = [
    ...(employeeId ? [{ value: 'mine' as const, label: 'My leave' }] : []),
    ...(can('leave.approve') || isManager ? [{ value: 'approvals' as const, label: 'Approvals' }] : []),
    ...(can('leave.view') ? [{ value: 'all' as const, label: 'All requests' }, { value: 'balances' as const, label: 'Balances' }] : []),
    ...(can('leave.manage') ? [{ value: 'types' as const, label: 'Leave types' }] : []),
  ];
  if (me.isLoading || !companyId) return <PageLoader />;
  const requested = params.get('tab') as TabKey | null;
  const active = tabs.find((t) => t.value === requested)?.value ?? tabs[0]?.value;
  return (
    <>
      <PageHeader title="Leave" description="Apply for leave, track balances and approve requests." />
      {tabs.length === 0 ? <div className="card"><EmptyState title="Leave self-service unavailable" description="Your account is not linked to an employee profile." /></div> : (
        <>
          <Tabs className="mb-5" value={active!} onChange={(t) => setParams({ tab: t }, { replace: true })} tabs={tabs} />
          {active === 'mine' && employeeId && <MyLeave companyId={companyId} employeeId={employeeId} />}
          {active === 'approvals' && <Approvals companyId={companyId} myEmployeeId={employeeId} />}
          {active === 'all' && <AllRequests companyId={companyId} />}
          {active === 'balances' && <Balances companyId={companyId} />}
          {active === 'types' && <LeaveTypes companyId={companyId} />}
        </>
      )}
    </>
  );
}
