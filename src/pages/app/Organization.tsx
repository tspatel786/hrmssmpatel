import { ChevronDown, ChevronRight, Network, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { DataTable, type Column } from '@/components/DataTable';
import { clean, FormModal, type FieldDef } from '@/components/FormModal';
import { Avatar, Badge, Button, ConfirmDialog, EmptyState, PageHeader, PageLoader, Tabs } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { useAction, useList, useTable } from '@/lib/hooks';
import { useDepartments, useEmployeeOptions } from '@/lib/lookups';
import { optId, optStr, reqStr } from '@/lib/schemas';

interface Dept { id: string; name: string; code: string | null; description: string | null; parent_id: string | null; parent_name: string | null; head_employee_id: string | null; head_name: string | null; is_active: boolean; employee_count: number }
interface Desig { id: string; title: string; level: string | null; department_id: string | null; department_name: string | null; description: string | null; is_active: boolean; employee_count: number }
interface EmpNode { id: string; full_name: string; designation_title: string | null; department_name: string | null; manager_id: string | null }

const deptSchema = z.object({ name: reqStr(2, 80, 'Name'), code: optStr(10), parent_id: optId, head_employee_id: optId, description: optStr(500), is_active: z.boolean() });
const desigSchema = z.object({ title: reqStr(2, 80, 'Title'), level: optStr(20), department_id: optId, description: optStr(500), is_active: z.boolean() });

function Departments() {
  const { companyId, can } = useCompany();
  const table = useTable({ table: 'v_departments', companyId, searchColumns: ['name', 'code', 'head_name'], defaultSort: { column: 'name' } });
  const depts = useDepartments();
  const emps = useEmployeeOptions();
  const [editing, setEditing] = useState<Dept | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Dept | null>(null);
  const save = useAction((v: z.infer<typeof deptSchema>) => {
    const data = clean(v as Record<string, unknown>);
    return editing === 'new' ? api.db.insert('departments', { ...data, company_id: companyId }) : api.db.update('departments', (editing as Dept).id, data);
  }, { success: 'Department saved' });
  const remove = useAction((id: string) => api.db.remove('departments', id), { success: 'Department deleted', onSuccess: () => setDeleting(null) });
  const manage = can('departments.manage');
  const fields: FieldDef<z.infer<typeof deptSchema>>[] = [
    { name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code', placeholder: 'ENG' },
    { name: 'parent_id', label: 'Parent department', type: 'select', options: depts.options.filter((d) => editing === 'new' || d.value !== (editing as Dept | null)?.id) },
    { name: 'head_employee_id', label: 'Department head', type: 'select', options: emps.options },
    { name: 'description', label: 'Description', type: 'textarea', rows: 2 }, { name: 'is_active', label: 'Active', type: 'checkbox' },
  ];
  const columns: Column<Dept>[] = [
    { key: 'name', header: 'Department', sortable: true, render: (d) => <div><p className="font-medium text-slate-900">{d.name} {!d.is_active && <Badge className="ml-1">Inactive</Badge>}</p>{d.parent_name && <p className="text-xs text-slate-500">Under {d.parent_name}</p>}</div> },
    { key: 'code', header: 'Code', render: (d) => d.code ?? '—' },
    { key: 'head_name', header: 'Head', render: (d) => d.head_name || '—' },
    { key: 'employee_count', header: 'Employees', sortable: true },
  ];
  return (
    <>
      <DataTable table={table} columns={columns} searchPlaceholder="Search departments" exportName="departments"
        toolbar={manage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Add department</Button>}
        rowActions={manage ? (d) => <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(d)}><Pencil className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label="Delete" onClick={() => setDeleting(d)}><Trash2 className="h-4 w-4 text-rose-500" /></Button></div> : undefined}
        empty={{ title: 'No departments', action: manage && <Button size="sm" onClick={() => setEditing('new')}>Add department</Button> }} />
      <FormModal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add department' : 'Edit department'} size="md" schema={deptSchema} fields={fields}
        defaultValues={(editing && editing !== 'new' ? editing : { is_active: true }) as never} onSubmit={(v) => save.mutateAsync(v)} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete department?" tone="danger" confirmLabel="Delete" loading={remove.isPending}
        message={deleting?.employee_count ? `${deleting.employee_count} employee(s) will become unassigned.` : 'This department will be deleted.'} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </>
  );
}

function Designations() {
  const { companyId, can } = useCompany();
  const table = useTable({ table: 'v_designations', companyId, searchColumns: ['title', 'level', 'department_name'], defaultSort: { column: 'title' } });
  const depts = useDepartments();
  const [editing, setEditing] = useState<Desig | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Desig | null>(null);
  const save = useAction((v: z.infer<typeof desigSchema>) => {
    const data = clean(v as Record<string, unknown>);
    return editing === 'new' ? api.db.insert('designations', { ...data, company_id: companyId }) : api.db.update('designations', (editing as Desig).id, data);
  }, { success: 'Designation saved' });
  const remove = useAction((id: string) => api.db.remove('designations', id), { success: 'Designation deleted', onSuccess: () => setDeleting(null) });
  const manage = can('departments.manage');
  const columns: Column<Desig>[] = [
    { key: 'title', header: 'Designation', sortable: true, render: (d) => <span className="font-medium text-slate-900">{d.title} {!d.is_active && <Badge className="ml-1">Inactive</Badge>}</span> },
    { key: 'level', header: 'Level', sortable: true, render: (d) => d.level ?? '—' },
    { key: 'department_name', header: 'Department', render: (d) => d.department_name ?? 'Any' },
    { key: 'employee_count', header: 'Employees', sortable: true },
  ];
  return (
    <>
      <DataTable table={table} columns={columns} searchPlaceholder="Search designations" exportName="designations"
        filters={[{ key: 'department_id', label: 'Departments', options: depts.options }]}
        toolbar={manage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Add designation</Button>}
        rowActions={manage ? (d) => <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(d)}><Pencil className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label="Delete" onClick={() => setDeleting(d)}><Trash2 className="h-4 w-4 text-rose-500" /></Button></div> : undefined}
        empty={{ title: 'No designations' }} />
      <FormModal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add designation' : 'Edit designation'} size="md" schema={desigSchema}
        fields={[{ name: 'title', label: 'Title', required: true }, { name: 'level', label: 'Level', placeholder: 'L2 / M1' }, { name: 'department_id', label: 'Department', type: 'select', options: depts.options },
          { name: 'description', label: 'Description', type: 'textarea', rows: 2 }, { name: 'is_active', label: 'Active', type: 'checkbox' }]}
        defaultValues={(editing && editing !== 'new' ? editing : { is_active: true }) as never} onSubmit={(v) => save.mutateAsync(v)} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete designation?" tone="danger" confirmLabel="Delete" loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)} message={deleting?.employee_count ? `${deleting.employee_count} employee(s) use this designation.` : undefined} />
    </>
  );
}

function OrgNode({ node, children, depth }: { node: EmpNode; children: Map<string, EmpNode[]>; depth: number }) {
  const kids = children.get(node.id) ?? [];
  const [open, setOpen] = useState(depth < 2);
  return (
    <li>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 20 }}>
        {kids.length ? (
          <button type="button" className="rounded p-0.5 text-slate-400 hover:bg-slate-100" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : <span className="w-5" />}
        <Link to={`/app/employees/${node.id}`} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 hover:border-brand-300 hover:shadow-sm">
          <Avatar name={node.full_name} size="xs" />
          <span className="text-sm font-medium">{node.full_name}</span>
          <span className="text-xs text-slate-500">{node.designation_title ?? ''}{node.department_name ? ` · ${node.department_name}` : ''}</span>
          {kids.length > 0 && <Badge>{kids.length}</Badge>}
        </Link>
      </div>
      {open && kids.length > 0 && <ul>{kids.map((k) => <OrgNode key={k.id} node={k} children={children} depth={depth + 1} />)}</ul>}
    </li>
  );
}

function OrgChart() {
  const { companyId } = useCompany();
  const q = useList<EmpNode>(companyId ? { table: 'v_employees', columns: 'id,full_name,designation_title,department_name,manager_id', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'status', op: 'in', value: ['active', 'probation', 'notice'] }], order: [{ column: 'first_name' }], range: [0, 4999], count: false } : null);
  const { roots, children } = useMemo(() => {
    const rows = q.data?.rows ?? [];
    const ids = new Set(rows.map((r) => r.id));
    const children = new Map<string, EmpNode[]>();
    const roots: EmpNode[] = [];
    for (const r of rows) {
      if (r.manager_id && ids.has(r.manager_id)) children.set(r.manager_id, [...(children.get(r.manager_id) ?? []), r]);
      else roots.push(r);
    }
    roots.sort((a, b) => (children.get(b.id)?.length ?? 0) - (children.get(a.id)?.length ?? 0));
    return { roots, children };
  }, [q.data]);
  if (q.isLoading) return <PageLoader />;
  if (!roots.length) return <div className="card"><EmptyState icon={<Network className="h-6 w-6" />} title="No employees yet" /></div>;
  return <div className="card overflow-x-auto p-5"><ul>{roots.map((r) => <OrgNode key={r.id} node={r} children={children} depth={0} />)}</ul></div>;
}

export function Organization() {
  const [tab, setTab] = useState<'departments' | 'designations' | 'chart'>('departments');
  return (
    <>
      <PageHeader title="Organization" description="Departments, designations and reporting structure." />
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[{ value: 'departments', label: 'Departments' }, { value: 'designations', label: 'Designations' }, { value: 'chart', label: 'Org chart' }]} />
      {tab === 'departments' ? <Departments /> : tab === 'designations' ? <Designations /> : <OrgChart />}
    </>
  );
}
