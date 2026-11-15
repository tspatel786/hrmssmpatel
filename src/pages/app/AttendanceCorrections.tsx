// Attendance correction requests: employees request, their manager or HR (attendance.manage) approves/rejects.
import { format } from 'date-fns';
import { CheckCircle2, ClipboardEdit, XCircle } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge } from '@/components/DataTable';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageLoader, Select, Tabs, Textarea } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { fmtDate, fmtRelative, fmtTime, titleCase } from '@/lib/format';
import { useAction, useList } from '@/lib/hooks';

export interface Correction {
  id: string; employee_id: string; employee_name: string; employee_code: string; department_name: string | null; manager_id: string | null;
  attendance_date: string; requested_status: string; requested_check_in: string | null; requested_check_out: string | null; reason: string;
  status: string; original_check_in: string | null; original_check_out: string | null; original_status: string | null;
  reviewer_name: string | null; reviewed_at: string | null; review_note: string | null; created_at: string;
}

const STATUS_OPTS = [{ value: 'present', label: 'Present' }, { value: 'half_day', label: 'Half day' }, { value: 'absent', label: 'Absent' }];
const span = (i: string | null, o: string | null) => (i ? `${fmtTime(i)} – ${o ? fmtTime(o) : '…'}` : '—');

export function RequestCorrectionModal({ open, onClose, companyId, initialDate }: { open: boolean; onClose: () => void; companyId: string; initialDate?: string }) {
  const today = format(new Date(), 'yyyy-MM-dd');
  const [form, setForm] = useState({ date: initialDate ?? today, status: 'present', check_in: '09:30', check_out: '18:30', reason: '' });
  const [err, setErr] = useState('');
  const submit = useAction(() => {
    if (form.reason.trim().length < 5) throw new Error('Please explain the correction (at least 5 characters)');
    if (form.status !== 'absent' && !form.check_in) throw new Error('Check-in time is required');
    if (form.check_in && form.check_out && form.check_out <= form.check_in) throw new Error('Check-out must be after check-in');
    const ts = (t: string) => (t && form.status !== 'absent' ? new Date(`${form.date}T${t}`).toISOString() : null);
    return api.db.rpc('request_attendance_correction', { p_company: companyId, p_date: form.date, p_status: form.status,
      p_check_in: ts(form.check_in), p_check_out: ts(form.check_out), p_reason: form.reason.trim() });
  }, { success: 'Correction request submitted for approval', silent: true, onSuccess: () => { setForm((f) => ({ ...f, reason: '' })); onClose(); } });
  return (
    <Modal open={open} onClose={onClose} title="Request attendance correction" description="Your manager or HR will review it. You can request corrections for the last 60 days." size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={submit.isPending} onClick={() => { setErr(''); submit.mutate(undefined, { onError: (e) => setErr(e.message) }); }}>Submit request</Button></>}>
      <div className="space-y-4">
        {err && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        <Field label="Date" required><Input type="date" value={form.date} max={today} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Correct status" required><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} options={STATUS_OPTS} /></Field>
        {form.status !== 'absent' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Check-in" required><Input type="time" value={form.check_in} onChange={(e) => setForm({ ...form, check_in: e.target.value })} /></Field>
            <Field label="Check-out"><Input type="time" value={form.check_out} onChange={(e) => setForm({ ...form, check_out: e.target.value })} /></Field>
          </div>
        )}
        <Field label="Reason" required><Textarea rows={3} maxLength={1000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Forgot to clock in; biometric device was down" /></Field>
      </div>
    </Modal>
  );
}

export function CorrectionsPanel({ companyId, myEmployeeId }: { companyId: string; myEmployeeId?: string }) {
  const { can } = useCompany();
  const canManage = can('attendance.manage');
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [requesting, setRequesting] = useState(false);
  const [deciding, setDeciding] = useState<{ c: Correction; approve: boolean } | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const q = useList<Correction>({ table: 'v_attendance_corrections', filters: [{ column: 'company_id', op: 'eq', value: companyId }, ...(filter === 'pending' ? [{ column: 'status', op: 'eq' as const, value: 'pending' }] : [])],
    order: [{ column: 'created_at', ascending: false }], range: [0, 199] });
  const decide = useAction(() => api.db.rpc('decide_attendance_correction', { p_correction: deciding!.c.id, p_approve: deciding!.approve, p_note: note || null }),
    { success: () => (deciding?.approve ? 'Correction approved · attendance updated' : 'Correction rejected'), silent: true, onSuccess: () => setDeciding(null) });
  const cancel = useAction((id: string) => api.db.rpc('cancel_attendance_correction', { p_correction: id }), { success: 'Request cancelled' });
  const canReview = (c: Correction) => c.status === 'pending' && c.employee_id !== myEmployeeId && (canManage || (!!myEmployeeId && c.manager_id === myEmployeeId));
  const rows = q.data?.rows ?? [];

  return (
    <Card title="Attendance corrections" padded={false} actions={<>
      <Tabs value={filter} onChange={setFilter} tabs={[{ value: 'pending', label: 'Pending' }, { value: 'all', label: 'All' }]} />
      {myEmployeeId && <Button size="sm" icon={<ClipboardEdit className="h-4 w-4" />} onClick={() => setRequesting(true)}>Request correction</Button>}
    </>}>
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} /> : rows.length === 0 ? (
        <EmptyState icon={<ClipboardEdit className="h-6 w-6" />} title={filter === 'pending' ? 'No pending corrections' : 'No correction requests'}
          description="Missed a clock-in or recorded the wrong time? Request a correction and your manager or HR will review it." />
      ) : (
        <ul className="divide-y divide-slate-100" data-testid="corrections-list">
          {rows.map((c) => (
            <li key={c.id} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-start">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {c.employee_id === myEmployeeId ? 'You' : c.employee_name}<span className="text-xs text-slate-400">{c.employee_code}</span>
                  <span className="text-slate-400">·</span>{fmtDate(c.attendance_date, 'EEE, dd MMM yyyy')}
                  <StatusBadge kind="leave" value={c.status} />
                </p>
                <div className="mt-1.5 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                  <p><span className="text-slate-400">Recorded:</span> {c.original_status ? `${titleCase(c.original_status)} · ${span(c.original_check_in, c.original_check_out)}` : 'No record'}</p>
                  <p><span className="text-slate-400">Requested:</span> <span className="font-medium text-slate-800">{titleCase(c.requested_status)} · {span(c.requested_check_in, c.requested_check_out)}</span></p>
                </div>
                <p className="mt-1.5 text-sm text-slate-700">“{c.reason}”</p>
                <p className="mt-1 text-xs text-slate-400">Requested {fmtRelative(c.created_at)}{c.reviewer_name && ` · ${titleCase(c.status)} by ${c.reviewer_name} ${c.reviewed_at ? fmtRelative(c.reviewed_at) : ''}`}{c.review_note && ` — “${c.review_note}”`}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {canReview(c) && <>
                  <Button size="sm" variant="success" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => { setNote(''); setErr(''); setDeciding({ c, approve: true }); }}>Approve</Button>
                  <Button size="sm" variant="secondary" icon={<XCircle className="h-4 w-4" />} onClick={() => { setNote(''); setErr(''); setDeciding({ c, approve: false }); }}>Reject</Button>
                </>}
                {c.status === 'pending' && c.employee_id === myEmployeeId && <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(c.id)}>Cancel</Button>}
                {c.status === 'pending' && !canReview(c) && c.employee_id !== myEmployeeId && <Badge tone="gray">Awaiting manager</Badge>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <RequestCorrectionModal open={requesting} onClose={() => setRequesting(false)} companyId={companyId} />
      <Modal open={!!deciding} onClose={() => setDeciding(null)} size="sm" title={deciding?.approve ? 'Approve correction?' : 'Reject correction?'}
        description={deciding ? `${deciding.c.employee_name} · ${fmtDate(deciding.c.attendance_date)}` : undefined}
        footer={<><Button variant="secondary" onClick={() => setDeciding(null)}>Cancel</Button>
          <Button variant={deciding?.approve ? 'success' : 'danger'} loading={decide.isPending} onClick={() => { setErr(''); decide.mutate(undefined, { onError: (e) => setErr(e.message) }); }}>{deciding?.approve ? 'Approve' : 'Reject'}</Button></>}>
        {err && <div role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        {deciding?.approve && <p className="mb-3 text-sm text-slate-600">The attendance record will be updated to <strong>{titleCase(deciding.c.requested_status)} · {span(deciding.c.requested_check_in, deciding.c.requested_check_out)}</strong>.</p>}
        <Field label={deciding?.approve ? 'Note (optional)' : 'Reason for rejecting'} required={!deciding?.approve}><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Modal>
    </Card>
  );
}
