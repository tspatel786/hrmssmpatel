import { History } from 'lucide-react';
import { useState } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Drawer, Input, PageHeader } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { opts } from '@/lib/constants';
import { fmtDateTime, titleCase } from '@/lib/format';
import { useTable } from '@/lib/hooks';

interface Log { id: number; actor_name: string; actor_email: string | null; action: string; table_name: string; record_id: string | null; old_data: Record<string, unknown> | null; new_data: Record<string, unknown> | null; changed_fields: string[] | null; created_at: string }

const TABLES = ['companies', 'roles', 'company_members', 'company_invitations', 'departments', 'designations', 'employees', 'employee_documents', 'holidays', 'leave_types', 'leave_balances', 'leave_requests', 'payroll_runs', 'job_requisitions', 'jobs', 'candidates', 'applications', 'interviews', 'interview_feedback', 'offers', 'onboardings', 'email_templates', 'onboarding_task_templates'];
const TONE = { INSERT: 'green', UPDATE: 'blue', DELETE: 'red' } as const;
const SENSITIVE = /password|token|bank_account|pan_number/i;

function val(v: unknown, key: string) {
  if (SENSITIVE.test(key)) return '••••••';
  if (v === null || v === undefined) return '∅';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export function Audit() {
  const { companyId } = useCompany();
  const [viewing, setViewing] = useState<Log | null>(null);
  const table = useTable({ table: 'v_audit_logs', companyId, searchColumns: ['actor_name', 'actor_email', 'table_name'], defaultSort: { column: 'created_at', ascending: false }, pageSize: 50, filterOps: { created_at__from: 'gte', created_at__to: 'lte' } });
  const columns: Column<Log>[] = [
    { key: 'created_at', header: 'When', sortable: true, render: (l) => <span className="whitespace-nowrap">{fmtDateTime(l.created_at)}</span> },
    { key: 'actor_name', header: 'Actor', render: (l) => <span>{l.actor_name}<span className="block text-xs text-slate-500">{l.actor_email}</span></span> },
    { key: 'action', header: 'Action', render: (l) => <Badge tone={TONE[l.action as keyof typeof TONE]}>{l.action}</Badge> },
    { key: 'table_name', header: 'Entity', render: (l) => titleCase(l.table_name) },
    { key: 'changed_fields', header: 'Changes', hideOnMobile: true, render: (l) => <span className="line-clamp-1 max-w-[280px] text-xs text-slate-500">{l.changed_fields?.join(', ') ?? (l.action === 'INSERT' ? 'Created' : 'Deleted')}</span> },
  ];
  const keys = viewing ? (viewing.changed_fields ?? Object.keys(viewing.new_data ?? viewing.old_data ?? {})).filter((k) => !['updated_at'].includes(k)) : [];
  return (
    <>
      <PageHeader title="Audit logs" description="Tamper-evident record of every create, update and delete across the company." />
      <DataTable table={table} columns={columns} searchPlaceholder="Search actor or entity" exportName="audit-logs" onRowClick={setViewing}
        toolbar={<div className="flex items-center gap-2">
          <Input type="date" className="w-auto h-9" aria-label="From" value={table.filters.created_at__from ?? ''} onChange={(e) => table.setFilter('created_at__from', e.target.value)} />
          <span className="text-slate-400">–</span>
          <Input type="date" className="w-auto h-9" aria-label="To" value={(table.filters.created_at__to ?? '').slice(0, 10)} onChange={(e) => table.setFilter('created_at__to', e.target.value ? `${e.target.value}T23:59:59` : '')} />
        </div>}
        filters={[{ key: 'action', label: 'Actions', options: opts(['INSERT', 'UPDATE', 'DELETE'], (v) => v) }, { key: 'table_name', label: 'Entities', options: opts(TABLES) }]}
        empty={{ icon: <History className="h-6 w-6" />, title: 'No audit entries' }} />
      <Drawer open={!!viewing} onClose={() => setViewing(null)} title="Audit entry" width="max-w-2xl">
        {viewing && (
          <div className="space-y-4 text-sm">
            <p><Badge tone={TONE[viewing.action as keyof typeof TONE]}>{viewing.action}</Badge> <strong className="ml-1">{titleCase(viewing.table_name)}</strong> by {viewing.actor_name} · {fmtDateTime(viewing.created_at)}</p>
            <p className="font-mono text-xs text-slate-500">Record {viewing.record_id}</p>
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Field</th>{viewing.old_data && <th>Before</th>}{viewing.new_data && <th>After</th>}</tr></thead>
                <tbody>{keys.map((k) => (
                  <tr key={k}><td className="font-medium">{k}</td>
                    {viewing.old_data && <td className="max-w-[220px] break-all text-xs text-rose-700">{val(viewing.old_data[k], k)}</td>}
                    {viewing.new_data && <td className="max-w-[220px] break-all text-xs text-emerald-700">{val(viewing.new_data[k], k)}</td>}</tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}
