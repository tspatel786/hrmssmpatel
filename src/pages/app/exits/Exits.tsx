// /app/exits — resignation & exit (migration 2000): employee resigns -> reporting manager -> HR -> notice period ->
// exit checklist -> settlement -> relieving / experience letters -> exit completed -> access closed after the last day.
import { ArrowLeft, CheckCircle2, FileSignature, LogOut, Plus, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { FormModal, type FieldDef } from '@/components/FormModal';
import { Badge, Button, Card, ConfirmDialog, DescriptionList, EmptyState, ErrorState, Field, Input, Modal, PageHeader, PageLoader, Select, Tabs, type Tone } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { fmtDate, fmtDateTime, fmtMoney, titleCase } from '@/lib/format';
import { useAction, useList, useRpc } from '@/lib/hooks';
import { issueExitLetter } from '@/lib/letters';

export interface Resignation {
  id: string; company_id: string; employee_id: string; status: string; reason: string; resigned_on: string; proposed_last_day: string;
  approved_last_day: string | null; manager_user_id: string | null; manager_comment: string | null; manager_decided_at: string | null;
  hr_comment: string | null; hr_decided_at: string | null; withdrawal_requested: boolean; withdrawal_reason: string | null;
  settlement_status: string; settlement_amount: number | null; settlement_note: string | null; completed_at: string | null; deactivated_at: string | null;
  created_at: string; employee_name: string; employee_code: string; employee_email: string; employee_status: string; department_name: string | null;
  designation_title: string | null; joining_date: string; manager_name: string | null; days_left: number | null; tasks_total: number; tasks_done: number;
}

export const RESIGNATION_STATUS: Record<string, { tone: Tone; label: string }> = {
  pending_manager: { tone: 'yellow', label: 'Waiting for manager' },
  pending_hr: { tone: 'orange', label: 'Waiting for HR' },
  approved: { tone: 'blue', label: 'Serving notice' },
  completed: { tone: 'green', label: 'Exit completed' },
  rejected: { tone: 'red', label: 'Rejected' },
  withdrawn: { tone: 'gray', label: 'Withdrawn' },
};
const lastDay = (r: Resignation) => r.approved_last_day ?? r.proposed_last_day;
export function ResignationBadge({ r }: { r: Pick<Resignation, 'status' | 'withdrawal_requested' | 'deactivated_at'> }) {
  const s = RESIGNATION_STATUS[r.status] ?? { tone: 'gray' as Tone, label: titleCase(r.status) };
  return <span className="inline-flex flex-wrap gap-1"><Badge tone={s.tone}>{s.label}</Badge>{r.withdrawal_requested && <Badge tone="violet">Cancellation requested</Badge>}{r.deactivated_at && <Badge>Access closed</Badge>}</span>;
}

const resignSchema = z.object({
  reason: z.string().trim().min(10, 'Please explain the reason (at least 10 characters)').max(3000),
  last_day: z.string().min(1, 'Choose your proposed last working day'),
});
type ResignForm = z.infer<typeof resignSchema>;

function ResignationList({ rows, empty }: { rows: Resignation[]; empty: string }) {
  if (!rows.length) return <EmptyState icon={<LogOut className="h-6 w-6" />} title={empty} />;
  return (
    <ul className="divide-y divide-slate-100" data-testid="resignation-list">
      {rows.map((r) => (
        <li key={r.id}>
          <Link to={`/app/exits/${r.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hover:bg-slate-50">
            <span className="min-w-0">
              <span className="block font-medium text-slate-900">{r.employee_name} <span className="text-xs font-normal text-slate-500">{r.employee_code}</span></span>
              <span className="block text-xs text-slate-500">{r.designation_title ?? '—'} · resigned {fmtDate(r.resigned_on)} · last day {fmtDate(lastDay(r))}
                {r.status === 'approved' && r.days_left !== null && ` · ${r.days_left >= 0 ? `${r.days_left} day(s) left` : 'notice served'}`}
                {r.status === 'approved' && ` · checklist ${r.tasks_done}/${r.tasks_total}`}</span>
            </span>
            <ResignationBadge r={r} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Exits() {
  const { companyId, company, can } = useCompany();
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const me = useRpc<{ employee: { id: string } | null }>('my_dashboard', companyId ? { p_company: companyId } : null);
  const employeeId = me.data?.employee?.id;
  const all = useList<Resignation>(companyId ? { table: 'v_resignations', filters: [{ column: 'company_id', op: 'eq', value: companyId }], order: [{ column: 'created_at', ascending: false }], range: [0, 499] } : null);
  const [resigning, setResigning] = useState(false);
  const navigate = useNavigate();
  const hr = can('employees.view');

  if (all.isLoading || me.isLoading) return <PageLoader />;
  if (all.isError) return <ErrorState error={all.error} onRetry={() => void all.refetch()} />;
  const rows = all.data?.rows ?? [];
  const mine = rows.filter((r) => r.employee_id === employeeId);
  const active = mine.find((r) => ['pending_manager', 'pending_hr', 'approved'].includes(r.status));
  const team = rows.filter((r) => r.manager_user_id === user?.id);
  const tabs = [
    ...(employeeId ? [{ value: 'mine', label: 'My resignation' }] : []),
    ...(team.length ? [{ value: 'team', label: `My team${team.some((r) => r.status === 'pending_manager') ? ` (${team.filter((r) => r.status === 'pending_manager').length})` : ''}` }] : []),
    ...(hr ? [{ value: 'pending', label: 'Pending' }, { value: 'notice', label: 'On notice' }, { value: 'history', label: 'History' }] : []),
  ];
  const tab = tabs.find((t) => t.value === params.get('tab'))?.value ?? tabs[0]?.value;
  const noticeDays = company?.notice_period_days ?? 30;
  const defaultLast = new Date(Date.now() + noticeDays * 86400000).toISOString().slice(0, 10);
  const fields: FieldDef<ResignForm>[] = [
    { name: 'last_day', label: 'Proposed last working day', type: 'date', required: true, hint: `Company notice period: ${noticeDays} days` },
    { name: 'reason', label: 'Reason for resigning', type: 'textarea', rows: 5, required: true, span: 2 },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Resignation & exit" description="Resign, track approvals and the notice period, and complete exit formalities."
        actions={employeeId && !active && tab === 'mine' ? <Button icon={<LogOut className="h-4 w-4" />} onClick={() => setResigning(true)}>Submit resignation</Button> : undefined} />
      {tabs.length > 1 && <Tabs value={tab ?? ''} onChange={(t) => setParams({ tab: t }, { replace: true })} tabs={tabs} />}
      {!tab && <EmptyState icon={<LogOut className="h-6 w-6" />} title="Nothing to show" description="Your login is not linked to an employee record." />}
      {tab === 'mine' && (
        <Card padded={false} title="My resignations">
          <ResignationList rows={mine} empty="You have not submitted a resignation" />
        </Card>
      )}
      {tab === 'team' && <Card padded={false} title="Resignations from my team"><ResignationList rows={team} empty="No resignations from your team" /></Card>}
      {tab === 'pending' && <Card padded={false} title="Waiting for a decision"><ResignationList rows={rows.filter((r) => ['pending_manager', 'pending_hr'].includes(r.status) || r.withdrawal_requested)} empty="No pending resignations" /></Card>}
      {tab === 'notice' && <Card padded={false} title="Employees serving notice"><ResignationList rows={rows.filter((r) => r.status === 'approved' || (r.status === 'completed' && !r.deactivated_at))} empty="Nobody is serving notice" /></Card>}
      {tab === 'history' && <Card padded={false} title="All resignations"><ResignationList rows={rows} empty="No resignations yet" /></Card>}

      {resigning && companyId && (
        <FormModal open onClose={() => setResigning(false)} title="Submit resignation" size="md"
          description="Your reporting manager reviews it first, then HR. You keep working normally during the notice period."
          schema={resignSchema} fields={fields} defaultValues={{ reason: '', last_day: defaultLast }} submitLabel="Submit resignation"
          onSubmit={async (v) => {
            const id = await api.db.rpc<string>('submit_resignation', { p_company: companyId, p_reason: v.reason, p_last_day: v.last_day });
            void api.processEmails();
            setResigning(false);
            navigate(`/app/exits/${id}`);
          }} />
      )}
    </div>
  );
}

interface Task { id: string; title: string; category: string; is_completed: boolean; completed_at: string | null; sort_order: number }

export function ExitDetail() {
  const { id = '' } = useParams();
  const { company, can } = useCompany();
  const { user } = useSession();
  const q = useList<Resignation>({ table: 'v_resignations', filters: [{ column: 'id', op: 'eq', value: id }], count: false });
  const tasks = useList<Task>({ table: 'exit_tasks', filters: [{ column: 'resignation_id', op: 'eq', value: id }], order: [{ column: 'sort_order' }, { column: 'created_at' }], range: [0, 99] });
  const [deciding, setDeciding] = useState<{ step: 'manager' | 'hr' | 'withdrawal'; approve: boolean } | null>(null);
  const [hrApprove, setHrApprove] = useState<{ last: string; comment: string } | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [settling, setSettling] = useState<{ status: string; amount: string; note: string } | null>(null);
  const [completing, setCompleting] = useState(false);
  const [newTask, setNewTask] = useState('');

  const done = { onSuccess: () => { setDeciding(null); setHrApprove(null); setWithdrawing(false); setSettling(null); setCompleting(false); } };
  const decide = useAction(({ step, approve, comment }: { step: string; approve: boolean; comment: string }) =>
    step === 'manager' ? api.db.rpc('decide_resignation_manager', { p_resignation: id, p_approve: approve, p_comment: comment || null })
      : step === 'hr' ? api.db.rpc('decide_resignation_hr', { p_resignation: id, p_approve: approve, p_comment: comment || null })
        : api.db.rpc('decide_resignation_withdrawal', { p_resignation: id, p_approve: approve, p_comment: comment || null }), { success: 'Decision recorded · people notified', ...done });
  const approveHr = useAction((v: { last: string; comment: string }) => api.db.rpc('decide_resignation_hr', { p_resignation: id, p_approve: true, p_comment: v.comment || null, p_last_day: v.last }), { success: 'Resignation approved · notice period started', ...done });
  const withdraw = useAction((reason: string) => api.db.rpc<string>('withdraw_resignation', { p_resignation: id, p_reason: reason }), { success: (r) => (r === 'withdrawn' ? 'Resignation withdrawn' : 'Cancellation request sent to HR'), ...done });
  // optimistic: the tick shows at once, is reconciled with the server, and reverts if the save fails
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const toggle = useAction(({ t, v }: { t: Task; v: boolean }) => api.db.update('exit_tasks', t.id, { is_completed: v }), {
    onSuccess: (_r, { t }) => setOptimistic(({ [t.id]: _done, ...rest }) => rest),
  });
  const addTask = useAction(() => api.db.insert('exit_tasks', { company_id: company!.id, resignation_id: id, title: newTask.trim(), category: 'hr', sort_order: 100 + (tasks.data?.rows.length ?? 0) }), { success: 'Checklist item added', onSuccess: () => setNewTask('') });
  const delTask = useAction((tid: string) => api.db.remove('exit_tasks', tid));
  const settle = useAction((v: { status: string; amount: string; note: string }) => api.db.rpc('set_exit_settlement', { p_resignation: id, p_status: v.status, p_amount: v.amount ? Number(v.amount) : null, p_note: v.note || null }), { success: 'Settlement saved', ...done });
  const complete = useAction(() => api.db.rpc<string>('complete_exit', { p_resignation: id }), { success: (r) => (r === 'deactivated' ? 'Exit completed · access closed' : 'Exit completed · access closes after the last working day'), ...done });
  const letter = useAction(({ kind, r }: { kind: 'relieving_letter' | 'experience_letter'; r: Resignation }) =>
    issueExitLetter(r.employee_id, kind, company!, { last_working_day: lastDay(r), resigned_on: r.resigned_on }), { success: 'Letter saved to documents and emailed' });

  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const r = q.data?.rows[0];
  if (!r) return <ErrorState error="Resignation not found or you do not have access." />;
  const hr = can('employees.manage');
  const isMine = r.employee_email?.toLowerCase() === user?.email?.toLowerCase();
  const isManager = r.manager_user_id === user?.id;
  const rows = tasks.data?.rows ?? [];
  const editable = hr && r.status === 'approved';

  return (
    <div className="space-y-5">
      <PageHeader breadcrumb={<Link to="/app/exits" className="inline-flex items-center gap-1 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Resignation & exit</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{r.employee_name} <ResignationBadge r={r} /></span>}
        description={`${r.employee_code} · ${r.designation_title ?? 'No designation'} · ${r.department_name ?? 'No department'}`}
        actions={<>
          {isManager && r.status === 'pending_manager' && <>
            <Button variant="ghost" className="text-rose-600" onClick={() => setDeciding({ step: 'manager', approve: false })}>Reject</Button>
            <Button onClick={() => setDeciding({ step: 'manager', approve: true })}>Approve</Button>
          </>}
          {hr && !isMine && r.status === 'pending_hr' && <>
            <Button variant="ghost" className="text-rose-600" onClick={() => setDeciding({ step: 'hr', approve: false })}>Reject</Button>
            <Button onClick={() => setHrApprove({ last: r.proposed_last_day, comment: '' })}>Approve</Button>
          </>}
          {hr && r.withdrawal_requested && <>
            <Button variant="ghost" onClick={() => setDeciding({ step: 'withdrawal', approve: false })}>Keep resignation</Button>
            <Button variant="secondary" onClick={() => setDeciding({ step: 'withdrawal', approve: true })}>Approve cancellation</Button>
          </>}
          {isMine && ['pending_manager', 'pending_hr', 'approved'].includes(r.status) && !r.withdrawal_requested &&
            <Button variant="secondary" icon={<Undo2 className="h-4 w-4" />} onClick={() => setWithdrawing(true)}>{r.status === 'approved' ? 'Request cancellation' : 'Withdraw'}</Button>}
        </>} />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Resignation" className="lg:col-span-2">
          <DescriptionList items={[
            { label: 'Submitted', value: fmtDate(r.resigned_on) },
            { label: 'Proposed last day', value: fmtDate(r.proposed_last_day) },
            { label: 'Approved last day', value: r.approved_last_day ? fmtDate(r.approved_last_day) : '—' },
            { label: 'Notice', value: r.status === 'approved' && r.days_left !== null ? (r.days_left >= 0 ? `${r.days_left} day(s) left` : 'Served') : '—' },
            { label: 'Reporting manager', value: r.manager_name ?? 'None — goes straight to HR' },
            { label: 'Joined', value: fmtDate(r.joining_date) },
            { label: 'Reason', value: <span className="whitespace-pre-line">{r.reason}</span> },
          ]} />
        </Card>
        <Card title="Approvals">
          <ol className="space-y-3 text-sm">
            <li><p className="font-medium text-slate-800">Manager</p><p className="text-slate-600">{r.manager_decided_at ? `Decided ${fmtDateTime(r.manager_decided_at)}` : r.status === 'pending_manager' ? 'Waiting' : r.manager_user_id ? '—' : 'Skipped (no manager)'}</p>{r.manager_comment && <p className="text-slate-500">“{r.manager_comment}”</p>}</li>
            <li><p className="font-medium text-slate-800">HR</p><p className="text-slate-600">{r.hr_decided_at ? `Decided ${fmtDateTime(r.hr_decided_at)}` : r.status === 'pending_hr' ? 'Waiting' : '—'}</p>{r.hr_comment && <p className="text-slate-500">“{r.hr_comment}”</p>}</li>
            {r.withdrawal_reason && <li><p className="font-medium text-slate-800">Withdrawal</p><p className="text-slate-500">“{r.withdrawal_reason}”</p></li>}
            {r.completed_at && <li><p className="font-medium text-emerald-700">Exit completed {fmtDateTime(r.completed_at)}</p>{r.deactivated_at && <p className="text-slate-500">Access closed {fmtDateTime(r.deactivated_at)}</p>}</li>}
          </ol>
        </Card>
      </div>

      {(r.status === 'approved' || r.status === 'completed') && (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card title={`Exit checklist (${r.tasks_done}/${r.tasks_total})`} className="lg:col-span-2" padded={false}>
            {rows.length === 0 ? <EmptyState title="No checklist items" /> : (
              <ul className="divide-y divide-slate-100" data-testid="exit-checklist">
                {rows.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                    <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-emerald-600" checked={optimistic[t.id] ?? t.is_completed} disabled={!editable}
                      onChange={(e) => {
                        const v = e.target.checked;
                        setOptimistic((o) => ({ ...o, [t.id]: v }));
                        toggle.mutate({ t, v }, { onError: () => setOptimistic(({ [t.id]: _x, ...rest }) => rest) });
                      }} aria-label={`Mark ${t.title} done`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm ${t.is_completed ? 'text-slate-400 line-through' : 'font-medium text-slate-800'}`}>{t.title}</span>
                      <span className="text-xs text-slate-500">{titleCase(t.category)}{t.completed_at ? ` · done ${fmtDate(t.completed_at)}` : ''}</span>
                    </span>
                    {editable && <Button variant="ghost" size="sm" aria-label={`Remove ${t.title}`} onClick={() => delTask.mutate(t.id)}><Trash2 className="h-4 w-4 text-slate-400" /></Button>}
                  </li>
                ))}
              </ul>
            )}
            {editable && (
              <form className="flex gap-2 border-t border-slate-100 p-4" onSubmit={(e) => { e.preventDefault(); if (newTask.trim().length >= 2) addTask.mutate(); }}>
                <Input placeholder="Add a checklist item…" value={newTask} onChange={(e) => setNewTask(e.target.value)} maxLength={120} aria-label="Checklist item" />
                <Button type="submit" variant="secondary" icon={<Plus className="h-4 w-4" />} disabled={newTask.trim().length < 2} loading={addTask.isPending}>Add</Button>
              </form>
            )}
          </Card>
          <div className="space-y-5">
            <Card title="Final settlement" actions={editable && <Button size="sm" variant="secondary" onClick={() => setSettling({ status: r.settlement_status, amount: r.settlement_amount?.toString() ?? '', note: r.settlement_note ?? '' })}>Update</Button>}>
              <p className="text-sm"><Badge tone={r.settlement_status === 'paid' ? 'green' : r.settlement_status === 'not_applicable' ? 'gray' : 'yellow'}>{titleCase(r.settlement_status)}</Badge></p>
              {r.settlement_amount !== null && <p className="mt-2 text-lg font-semibold">{fmtMoney(r.settlement_amount, company?.currency)}</p>}
              {r.settlement_note && <p className="mt-1 text-sm text-slate-500">{r.settlement_note}</p>}
            </Card>
            {hr && (
              <Card title="Exit documents">
                <div className="flex flex-col gap-2">
                  <Button variant="secondary" icon={<FileSignature className="h-4 w-4" />} loading={letter.isPending} onClick={() => letter.mutate({ kind: 'relieving_letter', r })}>Relieving letter</Button>
                  <Button variant="secondary" icon={<FileSignature className="h-4 w-4" />} loading={letter.isPending} onClick={() => letter.mutate({ kind: 'experience_letter', r })}>Experience letter</Button>
                  <Link to={`/app/employees/${r.employee_id}`} className="text-center text-xs text-brand-700 hover:underline">View all employee documents</Link>
                </div>
              </Card>
            )}
            {editable && <Button className="w-full" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setCompleting(true)}>Complete exit</Button>}
          </div>
        </div>
      )}

      <ConfirmDialog open={!!deciding} onClose={() => setDeciding(null)} loading={decide.isPending} tone={deciding?.approve ? 'success' : 'danger'}
        confirmLabel={deciding?.approve ? 'Approve' : 'Reject'}
        title={deciding?.step === 'withdrawal' ? (deciding.approve ? 'Approve the cancellation?' : 'Keep the resignation?') : deciding?.approve ? 'Approve resignation?' : 'Reject resignation?'}
        message={deciding?.step === 'manager' && deciding.approve ? 'It goes to HR for final approval.' : deciding?.step === 'withdrawal' && deciding.approve ? 'The employee continues and the notice period ends.' : undefined}
        input={{ label: deciding?.approve ? 'Comment (optional)' : 'Reason', required: !deciding?.approve, multiline: true }}
        onConfirm={(c) => deciding && decide.mutate({ step: deciding.step, approve: deciding.approve, comment: c })} />
      <Modal open={!!hrApprove} onClose={() => setHrApprove(null)} title="Approve resignation" size="sm"
        footer={<><Button variant="secondary" onClick={() => setHrApprove(null)}>Cancel</Button><Button loading={approveHr.isPending} disabled={!hrApprove?.last} onClick={() => hrApprove && approveHr.mutate(hrApprove)}>Approve & start notice</Button></>}>
        <p className="text-sm text-slate-600">The employee moves to “notice” and the exit checklist is created. Access closes the day after the last working day, once the exit is completed.</p>
        <Field label="Last working day" required className="mt-4"><Input type="date" value={hrApprove?.last ?? ''} onChange={(e) => setHrApprove((v) => v && { ...v, last: e.target.value })} /></Field>
        <Field label="Comment (optional)" className="mt-3"><Input value={hrApprove?.comment ?? ''} onChange={(e) => setHrApprove((v) => v && { ...v, comment: e.target.value })} /></Field>
      </Modal>
      <ConfirmDialog open={withdrawing} onClose={() => setWithdrawing(false)} loading={withdraw.isPending}
        title={r.status === 'approved' ? 'Request cancellation?' : 'Withdraw resignation?'}
        message={r.status === 'approved' ? 'HR decides whether the resignation can be cancelled.' : 'Your resignation will be withdrawn right away.'}
        input={{ label: 'Reason', required: true }} confirmLabel={r.status === 'approved' ? 'Send request' : 'Withdraw'} onConfirm={(t) => withdraw.mutate(t)} />
      <Modal open={!!settling} onClose={() => setSettling(null)} title="Final settlement" size="sm"
        footer={<><Button variant="secondary" onClick={() => setSettling(null)}>Cancel</Button><Button loading={settle.isPending} onClick={() => settling && settle.mutate(settling)}>Save</Button></>}>
        <Field label="Status"><Select value={settling?.status ?? 'pending'} onChange={(e) => setSettling((v) => v && { ...v, status: e.target.value })}
          options={['pending', 'processing', 'paid', 'not_applicable'].map((v) => ({ value: v, label: titleCase(v) }))} /></Field>
        <Field label="Amount" className="mt-3"><Input type="number" min={0} step="0.01" value={settling?.amount ?? ''} onChange={(e) => setSettling((v) => v && { ...v, amount: e.target.value })} /></Field>
        <Field label="Note" className="mt-3"><Input value={settling?.note ?? ''} onChange={(e) => setSettling((v) => v && { ...v, note: e.target.value })} maxLength={2000} /></Field>
      </Modal>
      <ConfirmDialog open={completing} onClose={() => setCompleting(false)} loading={complete.isPending} tone="success" confirmLabel="Complete exit"
        title="Complete the exit?" message={`Requires the checklist done and the settlement paid or not applicable. HRMS access closes ${new Date(lastDay(r)) < new Date() ? 'now' : `after ${fmtDate(lastDay(r))}`}.`}
        onConfirm={() => complete.mutate()} />
    </div>
  );
}
