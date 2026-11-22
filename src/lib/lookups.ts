import { useMemo } from 'react';
import type { Option } from '@/components/ui';
import { useCompanyId } from '@/contexts/session';
import { useList } from './hooks';

function useOptions<T extends Record<string, unknown>>(table: string, label: (r: T) => string, extra: { filters?: { column: string; op: 'eq' | 'neq' | 'in'; value: unknown }[]; order?: string; value?: string } = {}) {
  const companyId = useCompanyId();
  const q = useList<T>(companyId ? {
    table,
    filters: [{ column: 'company_id', op: 'eq', value: companyId }, ...(extra.filters ?? [])],
    order: [{ column: extra.order ?? 'name' }],
    range: [0, 999],
    count: false,
  } : null);
  const options: Option[] = useMemo(() => (q.data?.rows ?? []).map((r) => ({ value: String(r[extra.value ?? 'id']), label: label(r) })), [q.data, label, extra.value]);
  return { options, rows: q.data?.rows ?? [], isLoading: q.isLoading };
}

type R = Record<string, unknown>;

/** Designations for a department: those linked to it plus general ones (no department). All when none is chosen. */
export function designationsFor(rows: R[], departmentId: unknown): Option[] {
  const dept = departmentId ? String(departmentId) : '';
  return rows.filter((r) => !dept || !r.department_id || String(r.department_id) === dept).map((r) => ({ value: String(r.id), label: String(r.title) }));
}
const byName = (r: R) => String(r.name);
const byTitle = (r: R) => String(r.title);
const byFullName = (r: R) => `${r.full_name}${r.employee_code ? ` (${r.employee_code})` : ''}`;
const byMember = (r: R) => `${r.full_name || r.email}${r.role_name ? ` · ${r.role_name}` : ''}`;
const byLeaveType = (r: R) => `${r.name}${r.is_paid ? '' : ' (unpaid)'}`;

export const useDepartments = () => useOptions('departments', byName, { filters: [{ column: 'is_active', op: 'eq', value: true }] });
export const useDesignations = () => useOptions('designations', byTitle, { order: 'title', filters: [{ column: 'is_active', op: 'eq', value: true }] });
export const useEmployeeOptions = () =>
  useOptions('v_employees', byFullName, { order: 'first_name', filters: [{ column: 'status', op: 'in', value: ['active', 'probation', 'notice'] }] });
export const useMembers = () => useOptions('v_members', byMember, { order: 'full_name', value: 'user_id', filters: [{ column: 'status', op: 'eq', value: 'active' }] });
export const useRoles = () => useOptions('roles', byName);
export const useLeaveTypes = () => useOptions('leave_types', byLeaveType, { filters: [{ column: 'is_active', op: 'eq', value: true }] });
export const useJobs = () => useOptions('jobs', byTitle, { order: 'title' });
