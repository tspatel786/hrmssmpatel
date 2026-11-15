import { ArrowLeft, CalendarCheck, CheckCircle2, Plus, Trash2, UserCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StatusBadge, DataTable, type Column } from '@/components/DataTable';
import { Avatar, Badge, Button, Card, ConfirmDialog, DescriptionList, EmptyState, ErrorState, Field, Input, Modal, PageHeader, PageLoader, Select } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { appBaseUrl } from '@/lib/config';
import { opts } from '@/lib/constants';
import { fmtDate, fmtDateTime, titleCase } from '@/lib/format';
import { useAction, useList, useTable } from '@/lib/hooks';

interface Onb {
  id: string; company_id: string; offer_id: string; candidate_id: string; application_id: string; status: string; joining_date: string;
  joining_confirmed: boolean; joining_confirmed_at: string | null; employee_id: string | null; completed_at: string | null; notes: string | null;
  candidate_name: string; candidate_email: string; candidate_phone: string | null; job_title: string; offer_number: string;
  designation_title: string | null; department_name: string | null; employee_code: string | null; tasks_total: number; tasks_done: number; created_at: string;
}
interface Task { id: string; title: string; description: string | null; category: string; due_date: string | null; is_completed: boolean; completed_at: string | null; sort_order: number }

const CATEGORY_TONES = { hr: 'blue', it: 'violet', manager: 'orange', employee: 'green', finance: 'cyan' } as const;

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
      <span className="text-xs text-slate-500">{done}/{total}</span>
    </div>
  );
}

export function Onboarding() {
  const { companyId } = useCompany();
  const navigate = useNavigate();
  const table = useTable({ table: 'v_onboardings', companyId, searchColumns: ['candidate_name', 'job_title', 'candidate_email'], defaultSort: { column: 'joining_date', ascending: true } });
  const columns: Column<Onb>[] = [
    { key: 'candidate_name', header: 'New joiner', sortable: true, render: (o) => <div className="flex items-center gap-3"><Avatar name={o.candidate_name} size="sm" /><div><p className="font-medium text-slate-900">{o.candidate_name}</p><p className="text-xs text-slate-500">{o.designation_title ?? o.job_title}</p></div></div> },
    { key: 'joining_date', header: 'Joining', sortable: true, render: (o) => <span>{fmtDate(o.joining_date)}{o.joining_confirmed ? <Badge tone="green" className="ml-2">Confirmed</Badge> : <Badge tone="yellow" className="ml-2">Unconfirmed</Badge>}</span> },
    { key: 'tasks', header: 'Checklist', render: (o) => <Progress done={o.tasks_done} total={o.tasks_total} />, csv: (o) => `${o.tasks_done}/${o.tasks_total}` },
    { key: 'department_name', header: 'Department', hideOnMobile: true, render: (o) => o.department_name ?? '—' },
    { key: 'status', header: 'Status', sortable: true, render: (o) => <StatusBadge kind="onboarding" value={o.status} /> },
    { key: 'employee_code', header: 'Employee', hideOnMobile: true, render: (o) => o.employee_code ?? '—' },
  ];
  return (
    <>
      <PageHeader title="Onboarding" description="Candidates who accepted offers. Confirm joining, complete the checklist and convert them into employees." />
      <DataTable table={table} columns={columns} searchPlaceholder="Search new joiners" exportName="onboarding" onRowClick={(o) => navigate(`/app/onboarding/${o.id}`)}
        filters={[{ key: 'status', label: 'Status', options: opts(['pending', 'in_progress', 'completed', 'cancelled']) }]}
        mobileCard={(o) => <div className="flex items-center justify-between gap-2"><div><p className="font-medium">{o.candidate_name}</p><p className="text-xs text-slate-500">Joins {fmtDate(o.joining_date)}</p></div><StatusBadge kind="onboarding" value={o.status} /></div>}
        empty={{ icon: <UserCheck className="h-6 w-6" />, title: 'No one is onboarding right now', description: 'When a candidate accepts an offer, their onboarding starts here automatically.' }} />
    </>
  );
}

export function OnboardingDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { companyId, can } = useCompany();
  const q = useList<Onb>({ table: 'v_onboardings', filters: [{ column: 'id', op: 'eq', value: id }], count: false });
  const tasks = useList<Task>({ table: 'onboarding_tasks', filters: [{ column: 'onboarding_id', op: 'eq', value: id }], order: [{ column: 'sort_order' }, { column: 'created_at' }], range: [0, 199] });
  const [confirming, setConfirming] = useState(false);
  const [joinDate, setJoinDate] = useState('');
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [newTask, setNewTask] = useState({ title: '', category: 'hr', due_date: '' });

  // optimistic checkbox state: reflect the click immediately, reconcile with the server, revert on failure
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const toggle = useAction(({ t, v }: { t: Task; v: boolean }) => api.db.update('onboarding_tasks', t.id, { is_completed: v }), {
    onSuccess: (_r, { t }) => setOptimistic(({ [t.id]: _done, ...rest }) => rest),
  });
  const addTask = useAction(() => api.db.insert('onboarding_tasks', { company_id: companyId, onboarding_id: id, title: newTask.title.trim(), category: newTask.category, due_date: newTask.due_date || null, sort_order: (tasks.data?.rows.length ?? 0) + 10 }),
    { success: 'Task added', onSuccess: () => setNewTask({ title: '', category: 'hr', due_date: '' }) });
  const delTask = useAction((tid: string) => api.db.remove('onboarding_tasks', tid), { success: 'Task removed' });
  const confirm = useAction(() => api.db.rpc('confirm_joining', { p_onboarding: id, p_joining_date: joinDate }), { success: 'Joining confirmed · confirmation email queued', onSuccess: () => setConfirming(false) });
  const complete = useAction(() => api.db.rpc<string>('complete_onboarding', { p_onboarding: id, p_base_url: appBaseUrl() }), {
    success: 'Employee record created · welcome email queued', onSuccess: (empId) => navigate(`/app/employees/${empId}`),
  });
  const cancel = useAction((reason: string) => api.db.rpc('cancel_onboarding', { p_onboarding: id, p_reason: reason }), { success: 'Onboarding cancelled', onSuccess: () => setCancelling(false) });

  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const o = q.data?.rows[0];
  if (!o) return <ErrorState error="Onboarding not found." />;
  const manage = can('onboarding.manage') && !['completed', 'cancelled'].includes(o.status);
  const rows = tasks.data?.rows ?? [];
  const pending = rows.filter((t) => !t.is_completed).length;

  return (
    <>
      <PageHeader breadcrumb={<Link to="/app/onboarding" className="inline-flex items-center gap-1 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Onboarding</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{o.candidate_name} <StatusBadge kind="onboarding" value={o.status} /></span>}
        description={`${o.designation_title ?? o.job_title} · ${o.department_name ?? 'No department'} · Offer ${o.offer_number}`}
        actions={manage && (
          <>
            <Button variant="ghost" className="text-rose-600" onClick={() => setCancelling(true)}>Did not join</Button>
            <Button variant="secondary" icon={<CalendarCheck className="h-4 w-4" />} onClick={() => { setJoinDate(o.joining_date); setConfirming(true); }}>{o.joining_confirmed ? 'Change joining date' : 'Confirm joining'}</Button>
            <Button icon={<UserPlus className="h-4 w-4" />} disabled={!o.joining_confirmed} title={!o.joining_confirmed ? 'Confirm the joining date first' : undefined} onClick={() => setCompleting(true)}>Complete & create employee</Button>
          </>
        )} />
      {o.status === 'completed' && o.employee_id && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <CheckCircle2 className="h-5 w-5" /> Onboarding completed {fmtDateTime(o.completed_at)} — employee <Link className="font-semibold underline" to={`/app/employees/${o.employee_id}`}>{o.employee_code}</Link> created.
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Onboarding checklist" className="lg:col-span-2" actions={<Progress done={rows.length - pending} total={rows.length} />} padded={false}>
          {rows.length === 0 ? <EmptyState title="No checklist tasks" /> : (
            <ul className="divide-y divide-slate-100">
              {rows.map((t) => (
                <li key={t.id} className="flex items-start gap-3 px-5 py-3.5">
                  <input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-600" checked={optimistic[t.id] ?? t.is_completed} disabled={!manage}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setOptimistic((o) => ({ ...o, [t.id]: v }));
                      toggle.mutate({ t, v }, { onError: () => setOptimistic(({ [t.id]: _x, ...rest }) => rest) });
                    }} aria-label={`Mark ${t.title} complete`} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium ${t.is_completed ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{t.title}</p>
                    {t.description && <p className="text-xs text-slate-500">{t.description}</p>}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <Badge tone={CATEGORY_TONES[t.category as keyof typeof CATEGORY_TONES] ?? 'gray'}>{t.category.toUpperCase()}</Badge>
                      {t.due_date && <span className={!t.is_completed && t.due_date < new Date().toISOString().slice(0, 10) ? 'font-medium text-rose-600' : ''}>Due {fmtDate(t.due_date)}</span>}
                      {t.completed_at && <span>Done {fmtDate(t.completed_at)}</span>}
                    </div>
                  </div>
                  {manage && <Button variant="ghost" size="sm" aria-label="Remove task" onClick={() => delTask.mutate(t.id)}><Trash2 className="h-4 w-4 text-slate-400" /></Button>}
                </li>
              ))}
            </ul>
          )}
          {manage && (
            <form className="flex flex-col gap-2 border-t border-slate-100 p-4 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (newTask.title.trim().length >= 2) addTask.mutate(); }}>
              <Input placeholder="Add a task…" value={newTask.title} onChange={(e) => setNewTask({ ...newTask, title: e.target.value })} aria-label="Task title" maxLength={120} />
              <Select className="sm:w-32" value={newTask.category} onChange={(e) => setNewTask({ ...newTask, category: e.target.value })} options={opts(['hr', 'it', 'manager', 'employee', 'finance'], (v) => v.toUpperCase())} aria-label="Category" />
              <Input type="date" className="sm:w-40" value={newTask.due_date} onChange={(e) => setNewTask({ ...newTask, due_date: e.target.value })} aria-label="Due date" />
              <Button type="submit" variant="secondary" icon={<Plus className="h-4 w-4" />} disabled={newTask.title.trim().length < 2} loading={addTask.isPending}>Add</Button>
            </form>
          )}
        </Card>
        <Card title="Joiner details">
          <DescriptionList cols={1} items={[
            { label: 'Candidate', value: <Link className="text-brand-700 hover:underline" to={`/app/recruitment/candidates/${o.candidate_id}`}>{o.candidate_name}</Link> },
            { label: 'Email', value: o.candidate_email },
            { label: 'Phone', value: o.candidate_phone },
            { label: 'Joining date', value: <span>{fmtDate(o.joining_date)} {o.joining_confirmed ? <Badge tone="green">Confirmed {fmtDate(o.joining_confirmed_at)}</Badge> : <Badge tone="yellow">Not confirmed</Badge>}</span> },
            { label: 'Offer', value: <Link className="text-brand-700 hover:underline" to={`/app/offers/${o.offer_id}`}>{o.offer_number}</Link> },
            { label: 'Status', value: titleCase(o.status) },
            { label: 'Notes', value: o.notes ? <span className="whitespace-pre-line">{o.notes}</span> : '—' },
          ]} />
        </Card>
      </div>
      <Modal open={confirming} onClose={() => setConfirming(false)} title="Confirm joining date" size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button><Button loading={confirm.isPending} disabled={!joinDate} onClick={() => confirm.mutate()}>Confirm & notify</Button></>}>
        <p className="text-sm text-slate-600">The candidate will receive a joining confirmation email with reporting time and location.</p>
        <Field label="Joining date" required className="mt-4"><Input type="date" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} /></Field>
      </Modal>
      <ConfirmDialog open={completing} onClose={() => setCompleting(false)} loading={complete.isPending} tone="success" confirmLabel="Create employee"
        title="Complete onboarding?" message={<>An employee record will be created from the accepted offer, leave balances allocated and a welcome email sent.{pending > 0 && <span className="mt-2 block font-medium text-amber-700">{pending} checklist task(s) are still open.</span>}</>}
        onConfirm={() => complete.mutate()} />
      <ConfirmDialog open={cancelling} onClose={() => setCancelling(false)} loading={cancel.isPending} tone="danger" confirmLabel="Cancel onboarding"
        title="Candidate did not join?" message="The onboarding will be cancelled and the application marked as withdrawn." input={{ label: 'Reason', required: true }} onConfirm={(r) => cancel.mutate(r)} />
    </>
  );
}
