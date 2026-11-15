import { Plus, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { Avatar, Button, PageHeader } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES } from '@/lib/constants';
import { fmtDate, titleCase } from '@/lib/format';
import { useTable } from '@/lib/hooks';
import { useDepartments, useDesignations } from '@/lib/lookups';
import { EmployeeForm, type Employee } from './EmployeeForm';

export function Employees() {
  const { companyId, can } = useCompany();
  const navigate = useNavigate();
  const departments = useDepartments();
  const designations = useDesignations();
  const [creating, setCreating] = useState(false);
  const table = useTable({ table: 'v_employees', companyId, searchColumns: ['full_name', 'email', 'employee_code', 'phone', 'designation_title'], defaultSort: { column: 'employee_code' } });
  const columns: Column<Employee>[] = [
    { key: 'full_name', header: 'Employee', sortable: true, render: (e) => (
      <div className="flex items-center gap-3"><Avatar name={e.full_name} size="sm" /><div className="min-w-0"><p className="truncate font-medium text-slate-900">{e.full_name}</p><p className="truncate text-xs text-slate-500">{e.email}</p></div></div>
    ) },
    { key: 'employee_code', header: 'Code', sortable: true },
    { key: 'designation_title', header: 'Designation', render: (e) => <span>{e.designation_title ?? '—'}<span className="block text-xs text-slate-500">{e.department_name}</span></span>, csv: (e) => e.designation_title },
    { key: 'department_name', header: 'Department', hideOnMobile: true, className: 'hidden', render: (e) => e.department_name ?? '—' },
    { key: 'manager_name', header: 'Manager', hideOnMobile: true, render: (e) => e.manager_name || '—' },
    { key: 'employment_type', header: 'Type', hideOnMobile: true, render: (e) => titleCase(e.employment_type) },
    { key: 'joining_date', header: 'Joined', sortable: true, hideOnMobile: true, render: (e) => fmtDate(e.joining_date) },
    { key: 'status', header: 'Status', sortable: true, render: (e) => <StatusBadge kind="employee" value={e.status} /> },
  ];
  return (
    <>
      <PageHeader title="Employees" description="Your organization's people directory."
        actions={can('employees.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>Add employee</Button>} />
      <DataTable table={table} columns={columns.filter((c) => c.key !== 'department_name')} searchPlaceholder="Search name, code, email…" exportName="employees"
        onRowClick={(e) => navigate(`/app/employees/${e.id}`)}
        filters={[
          { key: 'status', label: 'Status', options: EMPLOYEE_STATUSES },
          { key: 'department_id', label: 'Departments', options: departments.options },
          { key: 'designation_id', label: 'Designations', options: designations.options },
          { key: 'employment_type', label: 'Types', options: EMPLOYMENT_TYPES },
        ]}
        mobileCard={(e) => <div className="flex items-center gap-3"><Avatar name={e.full_name} size="sm" /><div className="min-w-0 flex-1"><p className="font-medium">{e.full_name}</p><p className="truncate text-xs text-slate-500">{e.employee_code} · {e.designation_title ?? '—'}</p></div><StatusBadge kind="employee" value={e.status} /></div>}
        empty={{ icon: <UsersRound className="h-6 w-6" />, title: 'No employees yet', description: 'Add employees manually, or hire through the recruitment workflow.', action: can('employees.manage') && <Button size="sm" onClick={() => setCreating(true)}>Add employee</Button> }} />
      {creating && <EmployeeForm open onClose={() => setCreating(false)} onSaved={(id) => navigate(`/app/employees/${id}`)} />}
    </>
  );
}
