import { zodResolver } from '@hookform/resolvers/zod';
import { Check, ImageUp, Pencil, Plus, Shield, Trash2, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { DataTable, type Column } from '@/components/DataTable';
import { clean, FormFields, FormModal, type FieldDef } from '@/components/FormModal';
import { Avatar, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, Field, Input, Modal, PageHeader, PageLoader, Select, Tabs } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { appBaseUrl } from '@/lib/config';
import { opts, planLabel } from '@/lib/constants';
import { fmtDate } from '@/lib/format';
import { useAction, useList, useTable } from '@/lib/hooks';
import { useRoles } from '@/lib/lookups';
import { optEmail, optNum, optStr, optUrl, reqNum, reqStr } from '@/lib/schemas';

// ---------------- company profile & policies ----------------
const companySchema = z.object({
  name: reqStr(2, 120, 'Company name'), legal_name: optStr(160), email: optEmail, phone: optStr(30), website: optUrl,
  address: optStr(300), city: optStr(80), state: optStr(80), country: optStr(80), postal_code: optStr(12),
  timezone: z.string().min(1), currency: z.string().length(3),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color'), careers_enabled: z.boolean(), careers_tagline: optStr(160), careers_about: optStr(2000),
  employee_code_prefix: z.string().trim().regex(/^[A-Z0-9]{2,8}$/, '2–8 uppercase letters/numbers'), offer_approval_required: z.boolean(),
  offer_validity_days: reqNum(1, 90, 'Required'), work_start: z.string().min(4), work_end: z.string().min(4), late_grace_minutes: optNum(240).optional(), notice_period_days: optNum(180).optional(),
  pf_enabled: z.boolean(), pf_percent: reqNum(0, 50, 'Required'), professional_tax: reqNum(0, 100000, 'Required'), tds_percent: reqNum(0, 50, 'Required'),
  email_from_name: optStr(80), email_reply_to: optEmail, signatory_name: optStr(100).optional(), signatory_title: optStr(100).optional(),
}).refine((v) => v.work_end > v.work_start, { message: 'End must be after start', path: ['work_end'] });
type CompanyValues = z.infer<typeof companySchema>;

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function CompanySettings({ section }: { section: 'profile' | 'careers' | 'policies' }) {
  const { company, companyId, refresh } = useCompany();
  const [days, setDays] = useState<number[]>(company?.working_days ?? [1, 2, 3, 4, 5]);
  const [error, setError] = useState('');
  const form = useForm<CompanyValues>({ resolver: zodResolver(companySchema), defaultValues: company as never });
  useEffect(() => {
    if (company) { form.reset({ ...company, work_start: company.work_start?.slice(0, 5), work_end: company.work_end?.slice(0, 5) } as never); setDays(company.working_days); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company]);
  const save = useAction(async (v: CompanyValues) => {
    if (!days.length) throw new Error('Select at least one working day');
    const data: Record<string, unknown> = { ...clean(v as Record<string, unknown>), working_days: days };
    // column added by migration 1300: never send it to a database that does not have it yet
    if (!company || !('late_grace_minutes' in company) || data.late_grace_minutes == null) delete data.late_grace_minutes;
    // columns added by migration 2200
    for (const k of ['signatory_name', 'signatory_title']) if (!company || !(k in company)) delete data[k];
    // column added by migration 2000
    if (!company || !('notice_period_days' in company) || data.notice_period_days == null) delete data.notice_period_days;
    await api.db.update('companies', companyId!, data);
    await refresh();
  }, { success: 'Settings saved', silent: true });
  const logo = useAction(async (f: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(f.type)) throw new Error('Use a PNG, JPG, WEBP or SVG image');
    if (f.size > 1048576) throw new Error('Logo must be 1 MB or smaller');
    const path = `${companyId}/logo-${Date.now()}.${f.name.split('.').pop()}`;
    await api.storage.upload('company-assets', path, f, f.type);
    await api.db.update('companies', companyId!, { logo_url: await api.storage.publicUrl('company-assets', path) });
    await refresh();
  }, { success: 'Logo updated' });
  // letterhead for offer and appointment letters (migration 1900): full-width header and footer images
  const letterhead = useAction(async ({ part, f }: { part: 'header' | 'footer'; f: File | null }) => {
    const col = part === 'header' ? 'letterhead_header_url' : 'letterhead_footer_url';
    if (!f) { await api.db.update('companies', companyId!, { [col]: null }); await refresh(); return; }
    if (!['image/png', 'image/jpeg'].includes(f.type)) throw new Error('Use a PNG or JPG image');
    if (f.size > 1048576) throw new Error('Image must be 1 MB or smaller');
    const path = `${companyId}/letterhead-${part}-${Date.now()}.${f.type === 'image/png' ? 'png' : 'jpg'}`;
    await api.storage.upload('company-assets', path, f, f.type);
    await api.db.update('companies', companyId!, { [col]: await api.storage.publicUrl('company-assets', path) });
    await refresh();
  }, { success: 'Letterhead updated' });
  // authorised signatory's signature for letters (migration 2200)
  const signature = useAction(async (f: File | null) => {
    if (!f) { await api.db.update('companies', companyId!, { signature_url: null }); await refresh(); return; }
    if (!['image/png', 'image/jpeg'].includes(f.type)) throw new Error('Use a PNG (transparent background is best) or JPG image');
    if (f.size > 512000) throw new Error('Signature image must be 500 KB or smaller');
    const path = `${companyId}/signature-${Date.now()}.${f.type === 'image/png' ? 'png' : 'jpg'}`;
    await api.storage.upload('company-assets', path, f, f.type);
    await api.db.update('companies', companyId!, { signature_url: await api.storage.publicUrl('company-assets', path) });
    await refresh();
  }, { success: 'Signature updated' });
  if (!company) return <PageLoader />;
  const fields: Record<typeof section, FieldDef<CompanyValues>[]> = {
    profile: [
      { name: 'name', label: 'Company name', required: true }, { name: 'legal_name', label: 'Legal name' },
      { name: 'email', label: 'Contact email', type: 'email' }, { name: 'phone', label: 'Phone' }, { name: 'website', label: 'Website', type: 'url', span: 2 },
      { name: 'address', label: 'Address', span: 2 }, { name: 'city', label: 'City' }, { name: 'state', label: 'State' },
      { name: 'country', label: 'Country' }, { name: 'postal_code', label: 'Postal code' },
      { name: 'timezone', label: 'Timezone', type: 'select', options: TIMEZONES.map((t) => ({ value: t, label: t })), required: true },
      { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES.map((c) => ({ value: c, label: c })), required: true },
      { name: 'email_from_name', label: 'Email sender name' }, { name: 'email_reply_to', label: 'Reply-to address', type: 'email' },
      { name: 'signatory_name', label: 'Authorised signatory name', hidden: !('signatory_name' in company), hint: 'Printed under the signature on letters' },
      { name: 'signatory_title', label: 'Signatory designation', hidden: !('signatory_title' in company), hint: 'e.g. Director' },
    ],
    careers: [
      { name: 'careers_enabled', label: 'Public careers page enabled', type: 'checkbox', span: 2, hint: `${window.location.origin}/careers/${company.slug}` },
      { name: 'primary_color', label: 'Brand color', type: 'color' }, { name: 'careers_tagline', label: 'Headline' },
      { name: 'careers_about', label: 'About the company', type: 'textarea', rows: 4 },
    ],
    policies: [
      { name: 'employee_code_prefix', label: 'Employee code prefix', required: true, hint: 'e.g. EMP → EMP-0001' },
      { name: 'offer_validity_days', label: 'Default offer validity (days)', type: 'number', required: true },
      { name: 'offer_approval_required', label: 'Offers require approval before sending', type: 'checkbox', span: 2 },
      { name: 'work_start', label: 'Work day starts', type: 'time', required: true }, { name: 'work_end', label: 'Work day ends', type: 'time', required: true },
      { name: 'late_grace_minutes', label: 'Late / early grace (minutes)', type: 'number', hidden: !('late_grace_minutes' in company), hint: 'Arrivals after start + grace are flagged late; departures before end minus grace are flagged early' },
      { name: 'notice_period_days', label: 'Notice period (days)', type: 'number', hidden: !('notice_period_days' in company), hint: 'Suggested when an employee resigns; HR sets the final last working day' },
      { name: 'pf_enabled', label: 'Deduct provident fund (PF)', type: 'checkbox', span: 2 },
      { name: 'pf_percent', label: 'PF % of basic', type: 'number', step: '0.01' }, { name: 'professional_tax', label: 'Professional tax / month', type: 'number' },
      { name: 'tds_percent', label: 'Flat TDS % of gross', type: 'number', step: '0.01', hint: 'Simplified withholding; use 0 to disable' },
    ],
  };
  return (
    <form className="space-y-5" noValidate onSubmit={form.handleSubmit((v) => { setError(''); save.mutate(v, { onError: (e) => setError(e.message) }); })}>
      {section === 'careers' && (
        <Card title="Logo">
          <div className="flex items-center gap-4">
            <Avatar name={company.name} src={company.logo_url} size="lg" />
            <label className="btn-secondary cursor-pointer"><ImageUp className="h-4 w-4" /> {logo.isPending ? 'Uploading…' : 'Upload logo'}
              <input type="file" className="sr-only" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => { const f = e.target.files?.[0]; if (f) logo.mutate(f); e.target.value = ''; }} />
            </label>
            <p className="text-xs text-slate-500">PNG/JPG/SVG, max 1 MB. Shown on your careers page and offer pages.</p>
          </div>
        </Card>
      )}
      {section === 'profile' && (
        <Card title="Letterhead" actions={<span className="text-xs text-slate-500">Used on offer and appointment letters</span>}>
          <div className="grid gap-5 md:grid-cols-2">
            {(['header', 'footer'] as const).map((part) => {
              const url = part === 'header' ? company.letterhead_header_url : company.letterhead_footer_url;
              return (
                <div key={part}>
                  <p className="label">{part === 'header' ? 'Header (top of every page)' : 'Footer (bottom of every page)'}</p>
                  <div className="flex min-h-[72px] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white p-2">
                    {url ? <img src={url} alt={`Letterhead ${part}`} className="max-h-24 w-full object-contain" /> : <span className="text-xs text-slate-400">No {part} image</span>}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <label className="btn-secondary btn-sm cursor-pointer"><ImageUp className="h-4 w-4" /> {url ? 'Replace' : 'Upload'}
                      <input type="file" className="sr-only" accept="image/png,image/jpeg" aria-label={`Upload letterhead ${part}`}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) letterhead.mutate({ part, f }); e.target.value = ''; }} />
                    </label>
                    {url && <button type="button" className="btn-ghost btn-sm text-rose-600" onClick={() => letterhead.mutate({ part, f: null })}>Remove</button>}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-slate-500">Wide PNG or JPG images (about 2000 px wide), max 1 MB each. They are drawn edge to edge on A4, so include your own margins and lines in the image.</p>
          {'signature_url' in company && (
            <div className="mt-5 border-t border-slate-100 pt-4">
              <p className="label">Authorised signature (offer, appointment, relieving and experience letters)</p>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-16 w-44 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white p-2">
                  {company.signature_url ? <img src={company.signature_url} alt="Signature" className="max-h-12 object-contain" /> : <span className="text-xs text-slate-400">No signature</span>}
                </div>
                <label className="btn-secondary btn-sm cursor-pointer"><ImageUp className="h-4 w-4" /> {company.signature_url ? 'Replace' : 'Upload'}
                  <input type="file" className="sr-only" accept="image/png,image/jpeg" aria-label="Upload signature"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) signature.mutate(f); e.target.value = ''; }} />
                </label>
                {company.signature_url && <button type="button" className="btn-ghost btn-sm text-rose-600" onClick={() => signature.mutate(null)}>Remove</button>}
              </div>
              <p className="mt-2 text-xs text-slate-500">A PNG with a transparent background looks best; at least 400 px wide prints sharply. Set the signatory name and designation above.</p>
            </div>
          )}
        </Card>
      )}
      <Card>
        {error && <div role="alert" className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        <FormFields fields={fields[section]} form={form} />
        {section === 'policies' && (
          <Field label="Working days" className="mt-4">
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d, i) => (
                <button key={d} type="button" aria-pressed={days.includes(i + 1)} onClick={() => setDays((s) => (s.includes(i + 1) ? s.filter((x) => x !== i + 1) : [...s, i + 1].sort()))}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${days.includes(i + 1) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'}`}>{d}</button>
              ))}
            </div>
          </Field>
        )}
        <div className="mt-6 flex justify-end"><Button type="submit" loading={save.isPending}>Save changes</Button></div>
      </Card>
      <p className="text-xs text-slate-500">Plan: <strong>{planLabel(company.plan, company.status).plan}</strong> · Employee limit {company.max_employees} · Status {planLabel(company.plan, company.status).status}. Plan changes are handled by the platform administrator.</p>
    </form>
  );
}

// ---------------- users & invitations ----------------
interface Member { id: string; user_id: string; email: string; full_name: string | null; role_id: string; role_name: string; is_admin: boolean; status: string; employee_code: string | null; employee_name: string | null; created_at: string }
interface Invite { id: string; email: string; role_name: string; status: string; expires_at: string; created_at: string; invited_by_name: string | null }

function Users() {
  const { companyId } = useCompany();
  const { user } = useSession();
  const roles = useRoles();
  const table = useTable({ table: 'v_members', companyId, searchColumns: ['full_name', 'email', 'role_name'], defaultSort: { column: 'created_at' } });
  const invites = useList<Invite>(companyId ? { table: 'v_invitations', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'status', op: 'eq', value: 'pending' }], order: [{ column: 'created_at', ascending: false }] } : null);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [form, setForm] = useState({ email: '', role: '' });
  const [role, setRole] = useState('');
  const invite = useAction(() => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) throw new Error('Enter a valid email');
    if (!form.role) throw new Error('Select a role');
    return api.db.rpc<{ status: string }>('invite_member', { p_company: companyId, p_email: form.email, p_role: form.role, p_base_url: appBaseUrl() });
  }, { success: (r) => (r.status === 'invited' ? 'Invitation email queued' : 'User added to the company'), onSuccess: () => { setInviting(false); setForm({ email: '', role: '' }); } });
  const update = useAction((v: { id: string; role_id?: string; status?: string }) => api.db.update('company_members', v.id, { role_id: v.role_id, status: v.status }), { success: 'User updated', onSuccess: () => setEditing(null) });
  const remove = useAction((id: string) => api.db.remove('company_members', id), { success: 'User removed', onSuccess: () => setRemoving(null) });
  const revoke = useAction((id: string) => api.db.update('company_invitations', id, { status: 'revoked' }), { success: 'Invitation revoked' });
  const columns: Column<Member>[] = [
    { key: 'full_name', header: 'User', sortable: true, render: (m) => <div className="flex items-center gap-2"><Avatar name={m.full_name || m.email} size="sm" /><span><span className="font-medium">{m.full_name || m.email}{m.user_id === user?.id && <Badge className="ml-2">You</Badge>}</span><span className="block text-xs text-slate-500">{m.email}</span></span></div> },
    { key: 'role_name', header: 'Role', sortable: true, render: (m) => <Badge tone={m.is_admin ? 'violet' : 'blue'}>{m.role_name}</Badge> },
    { key: 'employee_name', header: 'Employee profile', hideOnMobile: true, render: (m) => (m.employee_code ? `${m.employee_name} (${m.employee_code})` : '—') },
    { key: 'status', header: 'Status', render: (m) => (m.status === 'active' ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
    { key: 'created_at', header: 'Since', hideOnMobile: true, render: (m) => fmtDate(m.created_at) },
  ];
  return (
    <div className="space-y-5">
      <DataTable table={table} columns={columns} searchPlaceholder="Search users" exportName="users"
        toolbar={<Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setInviting(true)}>Invite user</Button>}
        rowActions={(m) => m.user_id === user?.id ? null : <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" aria-label="Edit" onClick={() => { setEditing(m); setRole(m.role_id); }}><Pencil className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label="Remove" onClick={() => setRemoving(m)}><Trash2 className="h-4 w-4 text-rose-500" /></Button></div>}
        empty={{ title: 'No users' }} />
      <Card title={`Pending invitations (${invites.data?.rows.length ?? 0})`} padded={false}>
        {(invites.data?.rows ?? []).length === 0 ? <p className="p-5 text-sm text-slate-500">No pending invitations.</p> : (
          <ul className="divide-y divide-slate-100">
            {invites.data!.rows.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <span><span className="font-medium">{i.email}</span> <span className="text-slate-500">· {i.role_name} · expires {fmtDate(i.expires_at)}</span></span>
                <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => revoke.mutate(i.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal open={inviting} onClose={() => setInviting(false)} title="Invite user" size="sm"
        footer={<><Button variant="secondary" onClick={() => setInviting(false)}>Cancel</Button><Button loading={invite.isPending} onClick={() => invite.mutate()}>Send invitation</Button></>}>
        <p className="text-sm text-slate-600">Existing users are added immediately. New users receive an email invitation and join when they sign up with this address.</p>
        <Field label="Email" required className="mt-4"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Role" required className="mt-3"><Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} options={roles.options} placeholder="Select role" /></Field>
      </Modal>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Edit ${editing?.full_name || editing?.email || ''}`} size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => editing && update.mutate({ id: editing.id, status: editing.status === 'active' ? 'inactive' : 'active' })}>{editing?.status === 'active' ? 'Deactivate' : 'Activate'}</Button>
          <Button loading={update.isPending} onClick={() => editing && update.mutate({ id: editing.id, role_id: role })}>Save role</Button>
        </>}>
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)} options={roles.options} /></Field>
      </Modal>
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} title="Remove user from company?" tone="danger" confirmLabel="Remove" loading={remove.isPending}
        message={`${removing?.email} will lose access to this company immediately.`} onConfirm={() => removing && remove.mutate(removing.id)} />
    </div>
  );
}

// ---------------- roles & permissions ----------------
interface Role { id: string; name: string; description: string | null; is_system: boolean; is_admin: boolean; member_count: number; permission_count: number }
interface Perm { key: string; module: string; label: string; sort_order: number }

function Roles() {
  const { companyId } = useCompany();
  const roles = useList<Role>(companyId ? { table: 'v_roles', filters: [{ column: 'company_id', op: 'eq', value: companyId }], order: [{ column: 'name' }] } : null);
  const perms = useList<Perm>({ table: 'permissions', order: [{ column: 'sort_order' }], range: [0, 199] });
  const [selected, setSelected] = useState<Role | null>(null);
  const rp = useList<{ permission: string }>(selected ? { table: 'role_permissions', filters: [{ column: 'role_id', op: 'eq', value: selected.id }], range: [0, 199] } : null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);
  useEffect(() => setDraft(new Set((rp.data?.rows ?? []).map((r) => r.permission))), [rp.data]);
  useEffect(() => { if (!selected && roles.data?.rows.length) setSelected(roles.data.rows.find((r) => !r.is_admin) ?? roles.data.rows[0]); }, [roles.data, selected]);
  const grouped = useMemo(() => {
    const g = new Map<string, Perm[]>();
    for (const p of perms.data?.rows ?? []) g.set(p.module, [...(g.get(p.module) ?? []), p]);
    return [...g.entries()];
  }, [perms.data]);
  const save = useAction(async () => {
    const current = new Set((rp.data?.rows ?? []).map((r) => r.permission));
    const add = [...draft].filter((p) => !current.has(p));
    const del = [...current].filter((p) => !draft.has(p));
    if (del.length) await api.db.removeWhere('role_permissions', [{ column: 'role_id', op: 'eq', value: selected!.id }, { column: 'permission', op: 'in', value: del }]);
    if (add.length) await api.db.insertMany('role_permissions', add.map((permission) => ({ role_id: selected!.id, permission })));
  }, { success: 'Permissions saved' });
  const create = useAction((v: { name: string; description?: string | null }) => api.db.insert<Role>('roles', { ...clean(v), company_id: companyId }), { success: 'Role created', onSuccess: (r) => setSelected({ ...r, member_count: 0, permission_count: 0 }) });
  const remove = useAction((id: string) => api.db.remove('roles', id), { success: 'Role deleted', onSuccess: () => { setDeleting(null); setSelected(null); } });
  if (roles.isLoading) return <PageLoader />;
  const dirty = selected && !selected.is_admin && (draft.size !== (rp.data?.rows.length ?? 0) || (rp.data?.rows ?? []).some((r) => !draft.has(r.permission)));
  return (
    <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
      <div className="space-y-2">
        {(roles.data?.rows ?? []).map((r) => (
          <button key={r.id} type="button" onClick={() => setSelected(r)} className={`w-full rounded-xl border p-3 text-left transition ${selected?.id === r.id ? 'border-brand-300 bg-brand-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
            <p className="flex items-center gap-2 text-sm font-semibold">{r.is_admin && <Shield className="h-4 w-4 text-violet-600" />}{r.name}{r.is_system && <Badge className="ml-auto">System</Badge>}</p>
            <p className="mt-0.5 text-xs text-slate-500">{r.member_count} user(s) · {r.permission_count} permission(s)</p>
          </button>
        ))}
        <Button variant="secondary" className="w-full" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New role</Button>
      </div>
      {selected ? (
        <Card title={selected.name} actions={<>
          {!selected.is_system && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4 text-rose-500" />} onClick={() => setDeleting(selected)}>Delete</Button>}
          {!selected.is_admin && <Button size="sm" disabled={!dirty} loading={save.isPending} icon={<Check className="h-4 w-4" />} onClick={() => save.mutate()}>Save permissions</Button>}
        </>}>
          {selected.description && <p className="mb-4 text-sm text-slate-500">{selected.description}</p>}
          {selected.is_admin ? <p className="rounded-lg bg-violet-50 p-4 text-sm text-violet-800">Company Admins always have every permission.</p> : (
            <div className="grid gap-5 md:grid-cols-2">
              {grouped.map(([module, list]) => (
                <div key={module}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{module}</p>
                  <div className="space-y-2">{list.map((p) => <Checkbox key={p.key} label={p.label} description={p.key} checked={draft.has(p.key)} onChange={(v) => setDraft((d) => { const n = new Set(d); if (v) n.add(p.key); else n.delete(p.key); return n; })} />)}</div>
                </div>
              ))}
            </div>
          )}
          {!selected.is_admin && <p className="mt-5 text-xs text-slate-500">Every member also has self-service access to their own profile, attendance, leave, payslips, notifications and assigned interviews.</p>}
        </Card>
      ) : <Card><EmptyState title="Select a role" /></Card>}
      <FormModal open={creating} onClose={() => setCreating(false)} title="New role" size="sm" schema={z.object({ name: reqStr(2, 60, 'Name'), description: optStr(300) })}
        fields={[{ name: 'name', label: 'Role name', required: true, span: 2 }, { name: 'description', label: 'Description', type: 'textarea', rows: 2 }]} defaultValues={{}} onSubmit={(v) => create.mutateAsync(v)} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete role?" tone="danger" confirmLabel="Delete" loading={remove.isPending}
        message="Roles assigned to users cannot be deleted." onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </div>
  );
}

// ---------------- onboarding template ----------------
interface Tpl { id: string; title: string; description: string | null; category: string; due_offset_days: number; sort_order: number; is_active: boolean }
const tplSchema = z.object({ title: reqStr(2, 120, 'Title'), description: optStr(500), category: z.string(), due_offset_days: z.preprocess((v) => Number(v), z.number().int().min(-60).max(120)), sort_order: z.preprocess((v) => Number(v), z.number().int().min(0).max(999)), is_active: z.boolean() });
function OnboardingTemplate() {
  const { companyId } = useCompany();
  const q = useList<Tpl>(companyId ? { table: 'onboarding_task_templates', filters: [{ column: 'company_id', op: 'eq', value: companyId }], order: [{ column: 'sort_order' }], range: [0, 199] } : null);
  const [editing, setEditing] = useState<Tpl | 'new' | null>(null);
  const save = useAction((v: z.infer<typeof tplSchema>) => (editing === 'new' ? api.db.insert('onboarding_task_templates', { ...clean(v as Record<string, unknown>), company_id: companyId }) : api.db.update('onboarding_task_templates', (editing as Tpl).id, clean(v as Record<string, unknown>))), { success: 'Task saved' });
  const remove = useAction((id: string) => api.db.remove('onboarding_task_templates', id), { success: 'Task removed' });
  return (
    <Card title="Onboarding checklist template" padded={false} actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Add task</Button>}>
      <p className="px-5 pt-4 text-sm text-slate-500">Applied automatically when a candidate accepts an offer. Due dates are relative to the joining date.</p>
      {q.isLoading ? <PageLoader /> : (
        <ul className="divide-y divide-slate-100">
          {(q.data?.rows ?? []).map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-5 py-3">
              <Badge>{t.category.toUpperCase()}</Badge>
              <div className="min-w-0 flex-1"><p className={`text-sm font-medium ${!t.is_active ? 'text-slate-400 line-through' : ''}`}>{t.title}</p><p className="text-xs text-slate-500">{t.due_offset_days === 0 ? 'On joining day' : t.due_offset_days < 0 ? `${-t.due_offset_days} day(s) before joining` : `${t.due_offset_days} day(s) after joining`}</p></div>
              <Button size="sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(t)}><Pencil className="h-4 w-4" /></Button>
              <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => remove.mutate(t.id)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>
            </li>
          ))}
        </ul>
      )}
      <FormModal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add checklist task' : 'Edit checklist task'} size="md" schema={tplSchema}
        fields={[{ name: 'title', label: 'Title', required: true, span: 2 }, { name: 'category', label: 'Owner', type: 'select', options: opts(['hr', 'it', 'manager', 'employee', 'finance'], (v) => v.toUpperCase()) },
          { name: 'due_offset_days', label: 'Due (days from joining)', type: 'number', hint: 'Negative = before joining' }, { name: 'sort_order', label: 'Order', type: 'number' },
          { name: 'is_active', label: 'Active', type: 'checkbox' }, { name: 'description', label: 'Description', type: 'textarea', rows: 2 }]}
        defaultValues={(editing && editing !== 'new' ? editing : { category: 'hr', due_offset_days: 0, sort_order: (q.data?.rows.length ?? 0) + 1, is_active: true }) as never} onSubmit={(v) => save.mutateAsync(v)} />
    </Card>
  );
}

type Tab = 'profile' | 'careers' | 'policies' | 'users' | 'roles' | 'onboarding';
export function Settings() {
  const { can } = useCompany();
  const tabs: { value: Tab; label: string }[] = [
    ...(can('settings.manage') ? [{ value: 'profile' as const, label: 'Company profile' }, { value: 'careers' as const, label: 'Careers & branding' }, { value: 'policies' as const, label: 'HR & payroll policies' }] : []),
    ...(can('users.manage') ? [{ value: 'users' as const, label: 'Users' }, { value: 'roles' as const, label: 'Roles & permissions' }] : []),
    ...(can('onboarding.manage') ? [{ value: 'onboarding' as const, label: 'Onboarding checklist' }] : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs[0]?.value ?? 'profile');
  return (
    <>
      <PageHeader title="Settings" description="Configure your company workspace." />
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={tabs} />
      {(tab === 'profile' || tab === 'careers' || tab === 'policies') && <CompanySettings key={tab} section={tab} />}
      {tab === 'users' && <Users />}
      {tab === 'roles' && <Roles />}
      {tab === 'onboarding' && <OnboardingTemplate />}
    </>
  );
}
