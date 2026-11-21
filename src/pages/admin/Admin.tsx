import { ArrowLeft, Building2, LogOut, Mail, Pencil, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { z } from 'zod';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { FormModal, type FieldDef } from '@/components/FormModal';
import { Badge, Button, Card, ErrorState, PageHeader, PageLoader, StatCard } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { appBaseUrl, config } from '@/lib/config';
import { Logo } from '@/components/Logo';
import { opts, PLANS } from '@/lib/constants';
import { fmtDate, slugify, titleCase } from '@/lib/format';
import { useAction, useRpc, useTable } from '@/lib/hooks';
import { reqNum, reqStr } from '@/lib/schemas';

interface Co { id: string; name: string; slug: string; email: string | null; status: string; plan: string; max_employees: number; country: string | null; created_at: string; member_count: number; employee_count: number; open_jobs: number; created_by_email: string | null }
interface PStats { companies: number; active_companies: number; trial_companies: number; suspended_companies: number; users: number; employees: number; applications_30d: number; emails_30d: number; companies_by_plan: { plan: string; count: number }[]; signups_by_month: { month: string; count: number }[] }

const createSchema = z.object({
  name: reqStr(2, 120, 'Company name'),
  slug: z.string().trim().regex(/^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$/, '3–50 lowercase letters, numbers, hyphens'),
  admin_email: z.string().trim().email('Enter a valid email'),
  plan: z.string(),
  max_employees: reqNum(1, 100000, 'Required'),
});
const editSchema = z.object({ status: z.string(), plan: z.string(), max_employees: reqNum(1, 100000, 'Required') });

export function Admin() {
  const { user, loading, signOut } = useSession();
  const { isSuperAdmin, companiesLoading, companies, switchCompany } = useCompany();
  const navigate = useNavigate();
  const stats = useRpc<PStats>('admin_platform_stats', isSuperAdmin ? {} : null);
  const table = useTable({ table: 'v_admin_companies', searchColumns: ['name', 'slug', 'email'], defaultSort: { column: 'created_at', ascending: false }, companyId: undefined });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Co | null>(null);
  const create = useAction((v: z.infer<typeof createSchema>) => api.db.rpc('admin_create_company', { p_name: v.name, p_slug: v.slug, p_admin_email: v.admin_email, p_plan: v.plan, p_max_employees: v.max_employees, p_base_url: appBaseUrl() }),
    { success: 'Company created · admin invited' });
  const update = useAction((v: z.infer<typeof editSchema>) => api.db.rpc('admin_update_company', { p_company: editing!.id, p_status: v.status, p_plan: v.plan, p_max_employees: v.max_employees }), { success: 'Company updated' });

  if (loading || companiesLoading) return <div className="flex min-h-screen items-center justify-center"><PageLoader /></div>;
  if (!user) return <Navigate to="/login?next=/admin" replace />;
  if (!isSuperAdmin) return <Navigate to="/app" replace />;
  const s = stats.data;
  const columns: Column<Co>[] = [
    { key: 'name', header: 'Company', sortable: true, render: (c) => <div><p className="font-medium text-slate-900">{c.name}</p><p className="text-xs text-slate-500">/{c.slug} · {c.created_by_email ?? c.email ?? '—'}</p></div> },
    { key: 'plan', header: 'Plan', sortable: true, render: (c) => <Badge tone="violet">{titleCase(c.plan)}</Badge> },
    { key: 'status', header: 'Status', sortable: true, render: (c) => <StatusBadge kind="company" value={c.status} /> },
    { key: 'employee_count', header: 'Employees', render: (c) => `${c.employee_count} / ${c.max_employees}` },
    { key: 'member_count', header: 'Users', hideOnMobile: true },
    { key: 'open_jobs', header: 'Open jobs', hideOnMobile: true },
    { key: 'created_at', header: 'Created', sortable: true, hideOnMobile: true, render: (c) => fmtDate(c.created_at) },
  ];
  const createFields: FieldDef<z.infer<typeof createSchema>>[] = [
    { name: 'name', label: 'Company name', required: true, span: 2 }, { name: 'slug', label: 'URL slug', required: true, hint: 'Used for the careers page URL' },
    { name: 'admin_email', label: 'Company admin email', type: 'email', required: true }, { name: 'plan', label: 'Plan', type: 'select', options: PLANS, required: true },
    { name: 'max_employees', label: 'Employee limit', type: 'number', required: true },
  ];
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-brand-500/15 bg-ink text-white">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Logo size={34} showName={false} />
          <span className="font-display font-semibold">{config.appName} <span className="text-brand-400">Platform Admin</span></span>
          <div className="ml-auto flex items-center gap-2">
            {companies.length > 0 && <Link to="/app" className="btn-ghost text-slate-300 hover:bg-white/10 hover:text-white"><ArrowLeft className="h-4 w-4" /> Company app</Link>}
            <button type="button" className="btn-ghost text-slate-300 hover:bg-white/10 hover:text-white" onClick={async () => { await signOut(); navigate('/login'); }}><LogOut className="h-4 w-4" /> Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader title="SaaS super admin" description="Manage tenant companies, plans and platform health."
          actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New company</Button>} />
        {stats.isError ? <ErrorState error={stats.error} /> : s && (
          <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Companies" value={s.companies} icon={<Building2 className="h-5 w-5" />} hint={`${s.active_companies} active · ${s.trial_companies} trial · ${s.suspended_companies} suspended`} />
            <StatCard label="Users" value={s.users} icon={<Users className="h-5 w-5" />} tone="violet" />
            <StatCard label="Employees managed" value={s.employees} tone="green" />
            <StatCard label="Emails (30 days)" value={s.emails_30d} icon={<Mail className="h-5 w-5" />} tone="amber" hint={`${s.applications_30d} applications`} />
          </div>
        )}
        {s && s.signups_by_month.length > 0 && (
          <Card title="New companies by month" className="mb-5">
            <div className="h-56"><ResponsiveContainer><BarChart data={s.signups_by_month} margin={{ left: -20 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef2f7" /><XAxis dataKey="month" tick={{ fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fontSize: 12 }} /><Tooltip /><Bar dataKey="count" fill="#d4af37" radius={[4, 4, 0, 0]} name="Companies" /></BarChart></ResponsiveContainer></div>
          </Card>
        )}
        <DataTable table={table} columns={columns} searchPlaceholder="Search companies" exportName="companies"
          filters={[{ key: 'status', label: 'Status', options: opts(['active', 'trial', 'suspended']) }, { key: 'plan', label: 'Plans', options: PLANS }]}
          rowActions={(c) => <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => { switchCompany(c.id); navigate('/app'); }}>Open</Button>
            <Button size="sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></Button>
          </div>}
          empty={{ icon: <Building2 className="h-6 w-6" />, title: 'No companies yet' }} />
      </main>
      {creating && <FormModal open onClose={() => setCreating(false)} title="Create company" description="The admin is invited by email (or added directly if they already have an account)." schema={createSchema} fields={createFields}
        defaultValues={{ plan: 'starter', max_employees: 100 } as never} onSubmit={(v) => create.mutateAsync({ ...v, slug: v.slug || slugify(v.name) })} />}
      {editing && <FormModal open onClose={() => setEditing(null)} title={`Manage ${editing.name}`} size="md" schema={editSchema}
        fields={[{ name: 'status', label: 'Status', type: 'select', options: opts(['active', 'trial', 'suspended']), required: true, hint: 'Suspended companies lose access immediately' }, { name: 'plan', label: 'Plan', type: 'select', options: PLANS, required: true }, { name: 'max_employees', label: 'Employee limit', type: 'number', required: true }]}
        defaultValues={editing as never} onSubmit={(v) => update.mutateAsync(v)} />}
    </div>
  );
}
