// /app/documents — document management (migration 2000). Reuses employee_documents (HR uploads, letters) and adds employee
// self-upload with HR verification, expiry dates, history, and company-wide documents. Files stay in the private
// "documents" bucket and open through short-lived signed URLs.
import { AlertTriangle, Building2, Eye, FileText, History, ThumbsDown, ThumbsUp, Trash2, Upload, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal, PageHeader, PageLoader, Select, Tabs, type Tone } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { fileSize, fmtDate, fmtDateTime, titleCase } from '@/lib/format';
import { useAction, useList, useRpc } from '@/lib/hooks';

interface Doc {
  id: string; company_id: string; employee_id: string; doc_type: string; file_name: string; storage_path: string; size_bytes: number | null;
  status: 'pending' | 'verified' | 'rejected'; rejection_reason: string | null; expiry_date: string | null; uploaded_by: string | null; created_at: string;
}
interface CompanyDoc { id: string; title: string; category: string; visibility: 'all' | 'hr'; file_name: string; storage_path: string; size_bytes: number | null; expiry_date: string | null; created_at: string }

const SELF_TYPES = ['aadhaar', 'pan', 'id_proof', 'address_proof', 'personal', 'education', 'experience', 'tax', 'other'];
const ALL_TYPES = [...SELF_TYPES, 'contract', 'nda', 'agreement', 'offer_letter', 'appointment_letter', 'relieving_letter', 'experience_letter', 'salary_slip'];
const LABEL: Record<string, string> = { aadhaar: 'Aadhaar', pan: 'PAN', id_proof: 'ID proof', nda: 'NDA' };
const typeLabel = (t: string) => LABEL[t] ?? titleCase(t);
const STATUS: Record<Doc['status'], { tone: Tone; label: string }> = { pending: { tone: 'blue', label: 'Awaiting verification' }, verified: { tone: 'green', label: 'Verified' }, rejected: { tone: 'red', label: 'Rejected' } };
const ACCEPT = 'application/pdf,image/png,image/jpeg,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX = 10 * 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);
const expiryTone = (d: string | null): Tone | null => (!d ? null : d < today() ? 'red' : d <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) ? 'orange' : null);

function checkFile(f: File) {
  if (f.size > MAX) throw new Error('File must be 10 MB or smaller');
  if (!ACCEPT.split(',').includes(f.type)) throw new Error('Use a PDF, JPG, PNG or Word file');
}
const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
async function preview(path: string) {
  try {
    window.open(await api.storage.signedUrl('documents', path), '_blank', 'noopener');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

function DocRow({ d, who, actions }: { d: Doc; who?: string; actions?: React.ReactNode }) {
  const exp = expiryTone(d.expiry_date);
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <FileText className="h-5 w-5 shrink-0 text-slate-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800">{d.file_name}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {who && <span className="font-medium text-slate-600">{who}</span>}
          <span>{typeLabel(d.doc_type)}</span><span>· {fileSize(d.size_bytes)}</span><span>· {fmtDate(d.created_at)}</span>
          <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
          {d.expiry_date && <Badge tone={exp ?? 'gray'}>{d.expiry_date < today() ? 'Expired' : 'Expires'} {fmtDate(d.expiry_date)}</Badge>}
        </div>
        {d.status === 'rejected' && d.rejection_reason && <p className="mt-1 text-xs text-rose-600">Reason: {d.rejection_reason}</p>}
      </div>
      <span className="flex items-center gap-1">
        <Button variant="ghost" size="sm" icon={<Eye className="h-4 w-4" />} onClick={() => void preview(d.storage_path)}>View</Button>
        {actions}
      </span>
    </li>
  );
}

function HistoryModal({ doc, onClose }: { doc: Doc | null; onClose: () => void }) {
  const h = useRpc<{ action: string; status: string | null; actor_name: string | null; created_at: string; changed_fields: string[] | null }[]>('document_history', doc ? { p_document: doc.id } : null);
  return (
    <Modal open={!!doc} onClose={onClose} title={`History · ${doc?.file_name ?? ''}`} size="sm">
      {h.isLoading ? <PageLoader /> : (
        <ol className="space-y-2 text-sm" data-testid="document-history">
          {(h.data ?? []).map((e, i) => (
            <li key={i} className="flex justify-between gap-3 border-b border-slate-100 pb-2">
              <span>{e.action === 'INSERT' ? 'Uploaded' : e.action === 'DELETE' ? 'Deleted' : e.changed_fields?.includes('status') ? titleCase(e.status ?? 'updated') : 'Updated'}{e.actor_name ? ` by ${e.actor_name}` : ''}</span>
              <span className="shrink-0 text-xs text-slate-500">{fmtDateTime(e.created_at)}</span>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

function MyDocuments({ companyId, employeeId }: { companyId: string; employeeId: string }) {
  const docs = useList<Doc>({ table: 'employee_documents', filters: [{ column: 'employee_id', op: 'eq', value: employeeId }], order: [{ column: 'created_at', ascending: false }], range: [0, 199] });
  const [form, setForm] = useState<{ file: File | null; type: string; expiry: string }>({ file: null, type: 'aadhaar', expiry: '' });
  const [history, setHistory] = useState<Doc | null>(null);
  const upload = useAction(async () => {
    const f = form.file!;
    checkFile(f);
    const path = `${companyId}/employees/${employeeId}/self/${crypto.randomUUID()}/${safeName(f.name)}`;
    await api.storage.upload('documents', path, f, f.type);
    await api.db.insert('employee_documents', { company_id: companyId, employee_id: employeeId, doc_type: form.type, file_name: f.name.slice(0, 200), storage_path: path, mime_type: f.type, size_bytes: f.size, status: 'pending', expiry_date: form.expiry || null });
  }, { success: 'Uploaded · HR will verify it', onSuccess: () => setForm({ file: null, type: form.type, expiry: '' }) });
  const remove = useAction(async (d: Doc) => {
    await api.db.remove('employee_documents', d.id);
    await api.storage.remove('documents', d.storage_path).catch(() => undefined);
  }, { success: 'Document removed' });
  const rows = docs.data?.rows ?? [];

  return (
    <div className="space-y-5">
      <Card title="Upload a document">
        <form className="grid gap-3 md:grid-cols-[1fr_180px_170px_auto] md:items-end" onSubmit={(e) => { e.preventDefault(); if (form.file) upload.mutate(); }}>
          <Field label="File (PDF, JPG, PNG or Word · max 10 MB)"><input type="file" accept={ACCEPT} aria-label="Document file" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2"
            onChange={(e) => setForm({ ...form, file: e.target.files?.[0] ?? null })} /></Field>
          <Field label="Type"><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={SELF_TYPES.map((t) => ({ value: t, label: typeLabel(t) }))} aria-label="Document type" /></Field>
          <Field label="Expiry date (if any)"><Input type="date" value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} /></Field>
          <Button type="submit" icon={<Upload className="h-4 w-4" />} disabled={!form.file} loading={upload.isPending}>Upload</Button>
        </form>
      </Card>
      <Card title="My documents" padded={false} actions={<Link to="/app/payroll/my-payslips" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"><Wallet className="h-4 w-4" /> Salary slips</Link>}>
        {docs.isLoading ? <PageLoader /> : rows.length === 0 ? <EmptyState icon={<FileText className="h-6 w-6" />} title="No documents yet" description="Upload your Aadhaar, PAN and certificates. Letters from HR appear here too." /> : (
          <ul className="divide-y divide-slate-100" data-testid="my-documents">
            {rows.map((d) => <DocRow key={d.id} d={d} actions={<>
              <Button variant="ghost" size="sm" aria-label="History" onClick={() => setHistory(d)}><History className="h-4 w-4" /></Button>
              {d.status !== 'verified' && d.storage_path.includes('/self/') && <Button variant="ghost" size="sm" aria-label={`Remove ${d.file_name}`} onClick={() => remove.mutate(d)}><Trash2 className="h-4 w-4 text-slate-400" /></Button>}
            </>} />)}
          </ul>
        )}
      </Card>
      <HistoryModal doc={history} onClose={() => setHistory(null)} />
    </div>
  );
}

function EmployeeDocuments({ companyId, mode }: { companyId: string; mode: 'verify' | 'all' | 'expiring' }) {
  const filters = [{ column: 'company_id', op: 'eq' as const, value: companyId },
    ...(mode === 'verify' ? [{ column: 'status', op: 'eq' as const, value: 'pending' }] : []),
    ...(mode === 'expiring' ? [{ column: 'expiry_date', op: 'lte' as const, value: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) }] : [])];
  const docs = useList<Doc>({ table: 'employee_documents', filters, order: [{ column: mode === 'expiring' ? 'expiry_date' : 'created_at', ascending: mode === 'expiring' }], range: [0, 499] });
  const emps = useList<{ id: string; full_name: string; employee_code: string }>({ table: 'v_employees', columns: 'id,full_name,employee_code', filters: [{ column: 'company_id', op: 'eq', value: companyId }], range: [0, 999], count: false });
  const [rejecting, setRejecting] = useState<Doc | null>(null);
  const [history, setHistory] = useState<Doc | null>(null);
  const [type, setType] = useState('');
  const verify = useAction(({ d, approve, reason }: { d: Doc; approve: boolean; reason?: string }) =>
    api.db.rpc('verify_employee_document', { p_document: d.id, p_approve: approve, p_reason: reason ?? null }), { success: 'Saved · employee notified', onSuccess: () => setRejecting(null) });
  const name = new Map((emps.data?.rows ?? []).map((e) => [e.id, `${e.full_name} (${e.employee_code})`]));
  if (docs.isError) return <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />;
  const rows = (docs.data?.rows ?? []).filter((d) => !type || d.doc_type === type);

  return (
    <Card padded={false} title={mode === 'verify' ? 'Documents waiting for verification' : mode === 'expiring' ? 'Expired or expiring within 30 days' : 'All employee documents'}
      actions={mode === 'all' && <Select className="w-44 py-1.5" value={type} onChange={(e) => setType(e.target.value)} options={[{ value: '', label: 'All types' }, ...ALL_TYPES.map((t) => ({ value: t, label: typeLabel(t) }))]} aria-label="Filter by type" />}>
      {docs.isLoading ? <PageLoader /> : rows.length === 0 ? <EmptyState icon={<FileText className="h-6 w-6" />} title={mode === 'verify' ? 'Nothing to verify' : 'No documents'} /> : (
        <ul className="divide-y divide-slate-100" data-testid={`documents-${mode}`}>
          {rows.map((d) => <DocRow key={d.id} d={d} who={name.get(d.employee_id)} actions={<>
            <Button variant="ghost" size="sm" aria-label="History" onClick={() => setHistory(d)}><History className="h-4 w-4" /></Button>
            {d.status === 'pending' && <>
              <Button variant="success" size="sm" icon={<ThumbsUp className="h-4 w-4" />} loading={verify.isPending} onClick={() => verify.mutate({ d, approve: true })}>Verify</Button>
              <Button variant="ghost" size="sm" className="text-rose-600" icon={<ThumbsDown className="h-4 w-4" />} onClick={() => setRejecting(d)}>Reject</Button>
            </>}
            <Link to={`/app/employees/${d.employee_id}`} className="px-2 text-xs text-brand-700 hover:underline">Employee</Link>
          </>} />)}
        </ul>
      )}
      <ConfirmDialog open={!!rejecting} onClose={() => setRejecting(null)} tone="danger" confirmLabel="Reject" loading={verify.isPending}
        title={`Reject ${rejecting?.file_name ?? ''}?`} message="The employee is notified with your reason and can upload a corrected copy."
        input={{ label: 'Reason', required: true }} onConfirm={(reason) => rejecting && verify.mutate({ d: rejecting, approve: false, reason })} />
      <HistoryModal doc={history} onClose={() => setHistory(null)} />
    </Card>
  );
}

function CompanyDocuments({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const docs = useList<CompanyDoc>({ table: 'company_documents', filters: [{ column: 'company_id', op: 'eq', value: companyId }], order: [{ column: 'category' }, { column: 'title' }], range: [0, 499] });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', category: 'policy', visibility: 'all', expiry: '', file: null as File | null });
  const [deleting, setDeleting] = useState<CompanyDoc | null>(null);
  const add = useAction(async () => {
    const f = form.file!;
    checkFile(f);
    if (form.title.trim().length < 2) throw new Error('Give the document a title');
    const path = `${companyId}/company/${crypto.randomUUID()}/${safeName(f.name)}`;
    await api.storage.upload('documents', path, f, f.type);
    await api.db.insert('company_documents', { company_id: companyId, title: form.title.trim(), category: form.category, visibility: form.visibility, file_name: f.name.slice(0, 200), storage_path: path, mime_type: f.type, size_bytes: f.size, expiry_date: form.expiry || null });
  }, { success: 'Company document added', onSuccess: () => { setAdding(false); setForm({ title: '', category: 'policy', visibility: 'all', expiry: '', file: null }); } });
  const remove = useAction(async (d: CompanyDoc) => {
    await api.db.remove('company_documents', d.id);
    await api.storage.remove('documents', d.storage_path).catch(() => undefined);
  }, { success: 'Document deleted', onSuccess: () => setDeleting(null) });
  const rows = docs.data?.rows ?? [];

  return (
    <Card padded={false} title="Company documents" actions={canManage && <Button size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => setAdding(true)}>Add document</Button>}>
      {docs.isLoading ? <PageLoader /> : rows.length === 0 ? <EmptyState icon={<Building2 className="h-6 w-6" />} title="No company documents" description="Policies, the employee handbook and forms appear here." /> : (
        <ul className="divide-y divide-slate-100" data-testid="company-documents">
          {rows.map((d) => {
            const exp = expiryTone(d.expiry_date);
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Building2 className="h-5 w-5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{d.title}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>{titleCase(d.category)}</span><span>· {fileSize(d.size_bytes)}</span>
                    {d.visibility === 'hr' && <Badge tone="violet">HR only</Badge>}
                    {d.expiry_date && <Badge tone={exp ?? 'gray'}>Expires {fmtDate(d.expiry_date)}</Badge>}
                  </div>
                </div>
                <Button variant="ghost" size="sm" icon={<Eye className="h-4 w-4" />} onClick={() => void preview(d.storage_path)}>View</Button>
                {canManage && <Button variant="ghost" size="sm" aria-label={`Delete ${d.title}`} onClick={() => setDeleting(d)}><Trash2 className="h-4 w-4 text-slate-400" /></Button>}
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add company document" size="sm"
        footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button loading={add.isPending} disabled={!form.file || form.title.trim().length < 2} onClick={() => add.mutate()}>Upload</Button></>}>
        <div className="space-y-3">
          <Field label="Title" required><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={150} placeholder="e.g. Leave policy 2027" /></Field>
          <Field label="Category"><Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} options={['policy', 'handbook', 'form', 'agreement', 'certificate', 'other'].map((v) => ({ value: v, label: titleCase(v) }))} /></Field>
          <Field label="Who can see it"><Select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} options={[{ value: 'all', label: 'All employees' }, { value: 'hr', label: 'HR and admins only' }]} /></Field>
          <Field label="Expiry date (optional)"><Input type="date" value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} /></Field>
          <Field label="File (max 10 MB)" required><input type="file" accept={ACCEPT} aria-label="Company document file" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2" onChange={(e) => setForm({ ...form, file: e.target.files?.[0] ?? null })} /></Field>
        </div>
      </Modal>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} tone="danger" confirmLabel="Delete" loading={remove.isPending}
        title={`Delete ${deleting?.title ?? ''}?`} message="The file is removed for everyone." onConfirm={() => deleting && remove.mutate(deleting)} />
    </Card>
  );
}

export function Documents() {
  const { companyId, can } = useCompany();
  const [params, setParams] = useSearchParams();
  const me = useRpc<{ employee: { id: string } | null }>('my_dashboard', companyId ? { p_company: companyId } : null);
  const employeeId = me.data?.employee?.id;
  const hr = can('employees.manage');
  const tabs = [
    ...(employeeId ? [{ value: 'mine', label: 'My documents' }] : []),
    ...(hr ? [{ value: 'verify', label: 'To verify' }, { value: 'expiring', label: 'Expiring' }, { value: 'all', label: 'Employee documents' }] : []),
    { value: 'company', label: 'Company documents' },
  ];
  if (me.isLoading || !companyId) return <PageLoader />;
  const tab = tabs.find((t) => t.value === params.get('tab'))?.value ?? tabs[0].value;
  return (
    <div className="space-y-5">
      <PageHeader title="Documents" description="Personal documents, letters, agreements and company policies — private to your company." />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} tabs={tabs} />
      {tab === 'mine' && employeeId && <MyDocuments companyId={companyId} employeeId={employeeId} />}
      {(tab === 'verify' || tab === 'all' || tab === 'expiring') && hr && <EmployeeDocuments companyId={companyId} mode={tab} />}
      {tab === 'company' && <CompanyDocuments companyId={companyId} canManage={can('settings.manage')} />}
      {tab === 'expiring' && <p className="flex items-center gap-1.5 text-xs text-slate-500"><AlertTriangle className="h-4 w-4" /> Employees and HR are reminded 30 days, 7 days and on the day a document expires.</p>}
    </div>
  );
}
