import { ArrowLeft, BadgeCheck, Download, Eye, FileSignature, FileText, KeyRound, Mail, MapPin, Pencil, Phone, Send, Trash2, Upload } from 'lucide-react';

import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/DataTable';
import { Avatar, Badge, Button, Card, ConfirmDialog, DescriptionList, EmptyState, ErrorState, Field, Input, Modal, PageLoader, Select, Tabs } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { appBaseUrl } from '@/lib/config';
import { downloadBlob } from '@/lib/csv';
import { fileSize, fmtDate, fmtMoney, fmtTime, monthName, titleCase } from '@/lib/format';
import { useAction, useList } from '@/lib/hooks';
import { useRoles } from '@/lib/lookups';
import { issueAppointmentLetter } from '@/lib/letters';
import { generatePayslipPdf, type PayslipPdfData } from '@/lib/pdf';
import { EmployeeForm, type Employee } from './EmployeeForm';

interface Att { id: string; attendance_date: string; check_in: string | null; check_out: string | null; status: string; work_minutes: number | null }
interface Bal { id: string; leave_type_name: string; leave_type_color: string; allocated: number; used: number; available: number; year: number }
type Slip = PayslipPdfData & { id: string; run_status: string };
interface EmpDoc { id: string; doc_type: string; file_name: string; storage_path: string; size_bytes: number | null; created_at: string }
const EMP_DOC_TYPES = ['id_proof', 'address_proof', 'education', 'experience', 'contract', 'offer_letter', 'appointment_letter', 'tax', 'other'].map((v) => ({ value: v, label: titleCase(v) }));

export function EmployeeDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { companyId, company, can } = useCompany();
  const q = useList<Employee>({ table: 'v_employees', filters: [{ column: 'id', op: 'eq', value: id }], count: false });
  const att = useList<Att>({ table: 'attendance_records', filters: [{ column: 'employee_id', op: 'eq', value: id }], order: [{ column: 'attendance_date', ascending: false }], range: [0, 29] });
  const bal = useList<Bal>({ table: 'v_leave_balances', filters: [{ column: 'employee_id', op: 'eq', value: id }, { column: 'year', op: 'eq', value: new Date().getFullYear() }] });
  const slips = useList<Slip>({ table: 'v_payslips', filters: [{ column: 'employee_id', op: 'eq', value: id }], order: [{ column: 'period_year', ascending: false }, { column: 'period_month', ascending: false }], range: [0, 23] });
  const reports = useList<{ id: string; full_name: string; designation_title: string | null }>({ table: 'v_employees', columns: 'id,full_name,designation_title', filters: [{ column: 'manager_id', op: 'eq', value: id }], range: [0, 99] });
  const docPrefix = `${companyId}/employees/${id}/`;
  const docs = useList<EmpDoc>({ table: 'employee_documents', filters: [{ column: 'employee_id', op: 'eq', value: id }], order: [{ column: 'created_at', ascending: false }], range: [0, 199] });
  const roles = useRoles();
  const [tab, setTab] = useState<'overview' | 'attendance' | 'leave' | 'payslips' | 'documents'>('overview');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [role, setRole] = useState('');
  const [docType, setDocType] = useState('id_proof');
  const fileRef = useRef<HTMLInputElement>(null);

  const remove = useAction(() => api.db.remove('employees', id), { success: 'Employee deleted', onSuccess: () => navigate('/app/employees') });
  // Employee ID + one-time set-password link (migration 1900); works for staff added before the HRMS too
  const sendLogin = useAction(() => api.db.rpc('send_employee_login', { p_employee: id }), { success: 'Employee ID and set-password link emailed' });
  const sendAppointment = useAction(() => issueAppointmentLetter(id, company!), { success: 'Appointment letter saved to documents and emailed' });
  // probation review (migration 2100): confirm employment or extend the probation end date
  const [probation, setProbation] = useState<{ extendTo: string; note: string } | null>(null);
  const decideProbation = useAction(({ confirm }: { confirm: boolean }) => api.db.rpc('decide_probation', {
    p_employee: id, p_confirm: confirm, p_extend_to: confirm ? null : probation?.extendTo || null, p_note: probation?.note || null,
  }), { success: 'Probation decision saved · employee notified', onSuccess: () => setProbation(null) });
  const invite = useAction(() => api.db.rpc<{ status: string }>('invite_member', { p_company: companyId, p_email: q.data!.rows[0].email, p_role: role, p_employee: id, p_base_url: appBaseUrl() }), {
    success: (r) => (r.status === 'invited' ? 'Invitation email queued' : 'Access granted'), onSuccess: () => setInviting(false),
  });
  const uploadDoc = useAction(async (f: File) => {
    if (f.size > 10485760) throw new Error('File must be 10 MB or smaller');
    const name = `${Date.now()}-${f.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    await api.storage.upload('documents', docPrefix + name, f, f.type || 'application/pdf');
    await api.db.insert('employee_documents', { company_id: companyId, employee_id: id, doc_type: docType, file_name: f.name.slice(0, 200), storage_path: docPrefix + name, mime_type: f.type, size_bytes: f.size });
  }, { success: 'Document uploaded' });
  const delDoc = useAction(async (d: EmpDoc) => {
    await api.db.remove('employee_documents', d.id);
    await api.storage.remove('documents', d.storage_path).catch(() => undefined);
  }, { success: 'Document deleted' });

  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const e = q.data?.rows[0];
  if (!e) return <ErrorState error="Employee not found or you do not have access." />;
  const cur = company?.currency;
  const manage = can('employees.manage');
  const showPay = can(['employees.manage', 'payroll.view']) || !manage;
  // Company Admins (users.manage) may grant any role; HR (employees.manage) only the built-in Employee role
  const fullInvite = can('users.manage');
  const roleOptions = fullInvite ? roles.options : roles.options.filter((r) => r.label === 'Employee');

  return (
    <>
      <Link to={can('employees.view') ? '/app/employees' : '/app'} className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Back</Link>
      <div className="card mb-5 p-6">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-4">
            <Avatar name={e.full_name} size="lg" />
            <div>
              <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">{e.full_name} <StatusBadge kind="employee" value={e.status} /></h1>
              <p className="text-slate-600">{e.designation_title ?? 'Employee'} · {e.department_name ?? 'No department'} · {e.employee_code}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
                <a href={`mailto:${e.email}`} className="flex items-center gap-1 hover:text-brand-700"><Mail className="h-4 w-4" />{e.email}</a>
                {e.phone && <span className="flex items-center gap-1"><Phone className="h-4 w-4" />{e.phone}</span>}
                {e.work_location && <span className="flex items-center gap-1"><MapPin className="h-4 w-4" />{e.work_location}</span>}
              </div>
              <div className="mt-2">{e.user_id ? <Badge tone="green">Has HRMS login</Badge> : <Badge>No login yet</Badge>}</div>
            </div>
          </div>
          {manage && (
            <div className="flex shrink-0 flex-wrap gap-2">
              {!e.user_id && <Button icon={<Send className="h-4 w-4" />} loading={sendLogin.isPending} onClick={() => sendLogin.mutate()} title="Emails the Employee ID and a one-time link to set a password">Send login email</Button>}
              {!e.user_id && can('users.manage') && <Button variant="secondary" icon={<KeyRound className="h-4 w-4" />} onClick={() => { setRole(roles.rows.find((r) => r.name === 'Employee')?.id as string ?? ''); setInviting(true); }}>Give access with role</Button>}
              <Button variant="secondary" icon={<FileSignature className="h-4 w-4" />} loading={sendAppointment.isPending} onClick={() => sendAppointment.mutate()}>Appointment letter</Button>
              {e.status === 'probation' && <Button variant="secondary" icon={<BadgeCheck className="h-4 w-4" />} onClick={() => setProbation({ extendTo: '', note: '' })}>Probation review</Button>}
              <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="ghost" aria-label="Delete employee" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>
            </div>
          )}
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: 'Overview' }, { value: 'attendance', label: 'Attendance' }, { value: 'leave', label: 'Leave' },
        { value: 'payslips', label: 'Payslips', count: slips.data?.rows.length }, { value: 'documents', label: 'Documents' },
      ]} />
      <div className="mt-5">
        {tab === 'overview' && (
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Employment" className="lg:col-span-2">
              <DescriptionList items={[
                { label: 'Employee code', value: e.employee_code }, { label: 'Employment type', value: titleCase(e.employment_type) },
                { label: 'Department', value: e.department_name }, { label: 'Designation', value: e.designation_title },
                { label: 'Reporting manager', value: e.manager_id ? <Link className="text-brand-700 hover:underline" to={`/app/employees/${e.manager_id}`}>{e.manager_name}</Link> : '—' },
                { label: 'Joining date', value: fmtDate(e.joining_date) }, { label: 'Probation ends', value: fmtDate(e.probation_end_date) },
                { label: 'Exit date', value: fmtDate(e.exit_date) },
                { label: 'Hired via', value: e.candidate_id ? (can('candidates.view') ? <Link className="text-brand-700 hover:underline" to={`/app/recruitment/candidates/${e.candidate_id}`}>Recruitment</Link> : 'Recruitment') : 'Direct entry' },
              ]} />
              {showPay && (
                <>
                  <h3 className="mb-3 mt-6 border-t border-slate-100 pt-5 text-sm font-semibold">Compensation</h3>
                  <DescriptionList cols={3} items={[
                    { label: 'Annual CTC', value: fmtMoney(e.ctc_annual, cur) }, { label: 'Basic / month', value: fmtMoney(e.basic_monthly, cur) },
                    { label: 'HRA / month', value: fmtMoney(e.hra_monthly, cur) }, { label: 'Allowances / month', value: fmtMoney(e.allowances_monthly, cur) },
                    { label: 'Fixed deductions', value: fmtMoney(e.fixed_deductions_monthly, cur) },
                    { label: 'Bank', value: e.bank_name ? `${e.bank_name} ••••${(e.bank_account_number ?? '').slice(-4)}` : '—' },
                  ]} />
                </>
              )}
            </Card>
            <div className="space-y-5">
              <Card title="Personal">
                <DescriptionList cols={1} items={[
                  { label: 'Date of birth', value: fmtDate(e.date_of_birth) }, { label: 'Gender', value: titleCase(e.gender) },
                  { label: 'Address', value: [e.address, e.city, e.state, e.postal_code, e.country].filter(Boolean).join(', ') || '—' },
                  { label: 'Emergency contact', value: e.emergency_contact_name ? `${e.emergency_contact_name} · ${e.emergency_contact_phone ?? ''}` : '—' },
                ]} />
              </Card>
              <Card title={`Direct reports (${reports.data?.rows.length ?? 0})`}>
                {(reports.data?.rows ?? []).length === 0 ? <p className="text-sm text-slate-500">No direct reports.</p> : (
                  <ul className="space-y-2">{reports.data!.rows.map((r) => <li key={r.id}><Link to={`/app/employees/${r.id}`} className="flex items-center gap-2 text-sm hover:text-brand-700"><Avatar name={r.full_name} size="xs" />{r.full_name}<span className="text-xs text-slate-500">{r.designation_title}</span></Link></li>)}</ul>
                )}
              </Card>
            </div>
          </div>
        )}
        {tab === 'attendance' && (
          <Card title="Last 30 records" padded={false}>
            {(att.data?.rows ?? []).length === 0 ? <EmptyState title="No attendance records" /> : (
              <div className="overflow-x-auto"><table className="table"><thead><tr><th>Date</th><th>Status</th><th>Check-in</th><th>Check-out</th><th>Hours</th></tr></thead><tbody>
                {att.data!.rows.map((a) => <tr key={a.id}><td>{fmtDate(a.attendance_date, 'EEE, dd MMM yyyy')}</td><td><StatusBadge kind="attendance" value={a.status} /></td><td>{a.check_in ? fmtTime(a.check_in) : '—'}</td><td>{a.check_out ? fmtTime(a.check_out) : '—'}</td><td>{a.work_minutes ? (a.work_minutes / 60).toFixed(1) : '—'}</td></tr>)}
              </tbody></table></div>
            )}
          </Card>
        )}
        {tab === 'leave' && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(bal.data?.rows ?? []).length === 0 && <div className="card sm:col-span-4"><EmptyState title="No leave balances for this year" description="Allocate balances from the Leave page." /></div>}
            {(bal.data?.rows ?? []).map((b) => (
              <div key={b.id} className="card p-5">
                <p className="flex items-center gap-2 text-sm font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ background: b.leave_type_color }} />{b.leave_type_name}</p>
                <p className="mt-2 text-2xl font-semibold">{b.available}<span className="text-sm font-normal text-slate-500"> / {b.allocated} days</span></p>
                <p className="text-xs text-slate-500">{b.used} used in {b.year}</p>
              </div>
            ))}
          </div>
        )}
        {tab === 'payslips' && (
          <Card padded={false}>
            {(slips.data?.rows ?? []).length === 0 ? <EmptyState title="No payslips" /> : (
              <div className="overflow-x-auto"><table className="table"><thead><tr><th>Period</th><th>Paid days</th><th>Gross</th><th>Deductions</th><th>Net pay</th><th>Status</th><th /></tr></thead><tbody>
                {slips.data!.rows.map((s) => (
                  <tr key={s.id}><td>{monthName(s.period_month)} {s.period_year}</td><td>{s.paid_days}/{s.working_days}</td><td>{fmtMoney(s.gross, cur)}</td><td>{fmtMoney(s.total_deductions, cur)}</td><td className="font-semibold">{fmtMoney(s.net_pay, cur)}</td><td><StatusBadge kind="payroll" value={s.run_status} /></td>
                    <td><Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => downloadBlob(`Payslip-${e.employee_code}-${s.period_year}-${String(s.period_month).padStart(2, '0')}.pdf`, generatePayslipPdf({ ...s, company: company! }))}>PDF</Button></td></tr>
                ))}
              </tbody></table></div>
            )}
          </Card>
        )}
        {tab === 'documents' && (
          <Card title="Employee documents" actions={manage && <>
            <Select className="w-auto h-9" value={docType} onChange={(ev) => setDocType(ev.target.value)} options={EMP_DOC_TYPES} aria-label="Document type" />
            <Button size="sm" variant="secondary" icon={<Upload className="h-4 w-4" />} loading={uploadDoc.isPending} onClick={() => fileRef.current?.click()}>Upload</Button>
            <input ref={fileRef} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" onChange={(ev) => { const f = ev.target.files?.[0]; if (f) uploadDoc.mutate(f); ev.target.value = ''; }} /></>}>
            <p className="mb-3 text-sm text-slate-500">Stored privately — visible only to HR and the employee.</p>
            {(docs.data?.rows ?? []).length === 0 ? <EmptyState icon={<FileText className="h-6 w-6" />} title="No documents" description="Upload ID proofs, contracts and certificates." /> : (
              <ul className="divide-y divide-slate-100">
                {docs.data!.rows.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 py-2.5">
                    <FileText className="h-5 w-5 shrink-0 text-brand-600" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{d.file_name}</span><span className="text-xs text-slate-500">{titleCase(d.doc_type)} · {fileSize(d.size_bytes)} · {fmtDate(d.created_at)}</span></span>
                    <Button size="sm" variant="ghost" aria-label="View" onClick={async () => { try { window.open(await api.storage.signedUrl('documents', d.storage_path), '_blank', 'noopener'); } catch (err) { toast.error((err as Error).message); } }}><Eye className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Download" onClick={async () => { try { downloadBlob(d.file_name, await api.storage.download('documents', d.storage_path)); } catch (err) { toast.error((err as Error).message); } }}><Download className="h-4 w-4" /></Button>
                    {manage && <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => delDoc.mutate(d)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
      {editing && <EmployeeForm open employee={e} onClose={() => setEditing(false)} />}
      <Modal open={!!probation} onClose={() => setProbation(null)} title="Probation review" size="sm"
        footer={<>
          <Button variant="secondary" disabled={!probation?.extendTo} loading={decideProbation.isPending} onClick={() => decideProbation.mutate({ confirm: false })}>Extend probation</Button>
          <Button variant="success" loading={decideProbation.isPending} onClick={() => decideProbation.mutate({ confirm: true })}>Confirm employment</Button>
        </>}>
        <p className="text-sm text-slate-600">Probation ends {fmtDate(q.data?.rows[0]?.probation_end_date ?? null)}. Confirming makes the employee active; extending sets a new end date. The employee is notified either way.</p>
        <Field label="New probation end (only to extend)" className="mt-4"><Input type="date" value={probation?.extendTo ?? ''} onChange={(ev) => setProbation((v) => v && { ...v, extendTo: ev.target.value })} /></Field>
        <Field label="Note to the employee (optional)" className="mt-3"><Input value={probation?.note ?? ''} onChange={(ev) => setProbation((v) => v && { ...v, note: ev.target.value })} maxLength={300} /></Field>
      </Modal>
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} loading={remove.isPending} tone="danger" confirmLabel="Delete employee" title="Delete employee?"
        message="This permanently deletes the employee with their attendance, leave and payslips. To keep history, set the status to Inactive or Terminated instead." onConfirm={() => remove.mutate()} />
      <Modal open={inviting} onClose={() => setInviting(false)} title="Give HRMS access" size="sm"
        footer={<><Button variant="secondary" onClick={() => setInviting(false)}>Cancel</Button><Button disabled={!role} loading={invite.isPending} onClick={() => invite.mutate()}>Send invitation</Button></>}>
        <p className="text-sm text-slate-600">An invitation will be emailed to <strong>{e.email}</strong>. When they sign up with this email, they'll be linked to this employee profile.</p>
        <Field label="Role" className="mt-4" hint={fullInvite ? undefined : 'HR can grant the Employee role. A Company Admin can grant other roles later in Settings → Users.'}>
          <Select value={role} onChange={(ev) => setRole(ev.target.value)} options={roleOptions} placeholder="Select role" />
        </Field>
      </Modal>
    </>
  );
}
