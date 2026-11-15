import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { clean, FormFields, type FieldDef } from '@/components/FormModal';
import { Button, Modal } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { appBaseUrl } from '@/lib/config';
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, GENDERS, opts } from '@/lib/constants';
import { useAction } from '@/lib/hooks';
import { useDepartments, useDesignations, useEmployeeOptions } from '@/lib/lookups';
import { optDate, optEmail, optId, optNum, optStr, reqDate, reqStr } from '@/lib/schemas';

export interface Employee {
  id: string; company_id: string; employee_code: string; user_id: string | null; first_name: string; last_name: string; full_name: string;
  email: string; phone: string | null; date_of_birth: string | null; gender: string | null; marital_status: string | null; address: string | null;
  city: string | null; state: string | null; country: string | null; postal_code: string | null; emergency_contact_name: string | null;
  emergency_contact_phone: string | null; department_id: string | null; department_name: string | null; designation_id: string | null;
  designation_title: string | null; manager_id: string | null; manager_name: string | null; employment_type: string; work_location: string | null;
  joining_date: string; probation_end_date: string | null; exit_date: string | null; status: string; ctc_annual: number; basic_monthly: number;
  hra_monthly: number; allowances_monthly: number; fixed_deductions_monthly: number; pan_number: string | null; bank_name: string | null;
  bank_account_number: string | null; bank_ifsc: string | null; candidate_id: string | null; created_at: string;
}

const schema = z.object({
  first_name: reqStr(1, 60, 'First name'), last_name: optStr(60), email: z.string().trim().email('Enter a valid email'),
  phone: z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone').or(z.literal('')).optional().nullable(),
  date_of_birth: optDate, gender: optId, marital_status: optId, address: optStr(300), city: optStr(80), state: optStr(80), country: optStr(80), postal_code: optStr(12),
  emergency_contact_name: optStr(80), emergency_contact_phone: optStr(20),
  employee_code: optStr(20), department_id: optId, designation_id: optId, manager_id: optId, employment_type: z.string(), work_location: optStr(120),
  joining_date: reqDate('Joining date'), probation_end_date: optDate, exit_date: optDate, status: z.string(),
  ctc_annual: optNum(), basic_monthly: optNum(), hra_monthly: optNum(), allowances_monthly: optNum(), fixed_deductions_monthly: optNum(),
  pan_number: z.string().trim().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Format: ABCDE1234F').or(z.literal('')).optional().nullable(),
  bank_name: optStr(80), bank_account_number: z.string().trim().regex(/^[0-9]{6,20}$/, '6–20 digits').or(z.literal('')).optional().nullable(),
  bank_ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Format: HDFC0001234').or(z.literal('')).optional().nullable(),
  personal_email: optEmail,
})
  .refine((v) => !v.exit_date || v.exit_date >= v.joining_date, { message: 'Exit date must be after joining', path: ['exit_date'] })
  .refine((v) => !v.date_of_birth || v.date_of_birth < new Date(Date.now() - 14 * 365.25 * 86400000).toISOString().slice(0, 10), { message: 'Employee must be at least 14 years old', path: ['date_of_birth'] });
type Values = z.infer<typeof schema>;

export function EmployeeForm({ open, onClose, employee, onSaved }: { open: boolean; onClose: () => void; employee?: Employee | null; onSaved?: (id: string) => void }) {
  const { companyId, company } = useCompany();
  const departments = useDepartments();
  const designations = useDesignations();
  const managers = useEmployeeOptions();
  const [error, setError] = useState('');
  const form = useForm<Values>({ resolver: zodResolver(schema) });
  useEffect(() => {
    if (open) {
      setError('');
      form.reset((employee ?? { employment_type: 'full_time', status: 'active', joining_date: new Date().toISOString().slice(0, 10), country: company?.country ?? '' }) as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee]);
  const save = useAction(async (v: Values) => {
    const { personal_email: _p, ...rest } = v;
    void _p;
    const data = clean({ ...rest, email: rest.email.toLowerCase() } as Record<string, unknown>);
    for (const k of ['ctc_annual', 'basic_monthly', 'hra_monthly', 'allowances_monthly', 'fixed_deductions_monthly']) data[k] = data[k] ?? 0;
    if (employee) return { id: (await api.db.update<{ id: string }>('employees', employee.id, { ...data, employee_code: data.employee_code ?? employee.employee_code })).id, access: null };
    const id = (await api.db.insert<{ id: string }>('employees', { ...data, employee_code: data.employee_code ?? '', company_id: companyId })).id;
    // HRMS access is set up automatically: the new employee is invited with the Employee role (an existing account is
    // linked straight away). A failure here never undoes the saved employee; HR can retry with "Give HRMS access".
    let access: string | null = null;
    if (['active', 'probation'].includes(String(data.status ?? 'active'))) {
      try {
        const role = await api.db.list<{ id: string }>({ table: 'roles', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'name', op: 'eq', value: 'Employee' }], count: false });
        if (role.rows[0]) {
          const r = await api.db.rpc<{ status: string }>('invite_member', { p_company: companyId, p_email: data.email, p_role: role.rows[0].id, p_employee: id, p_base_url: appBaseUrl() });
          access = r.status === 'invited' ? `invitation emailed to ${String(data.email)}` : 'HRMS access granted';
        }
      } catch (e) {
        toast.warning(`Employee saved, but HRMS access was not set up: ${(e as Error).message}. Use "Give HRMS access" on the profile.`);
      }
    }
    return { id, access };
  }, { success: (r) => (employee ? 'Employee updated' : r.access ? `Employee created · ${r.access}` : 'Employee created'), onSuccess: (r) => onSaved?.(r.id), silent: true });

  const cur = company?.currency ?? 'INR';
  const sections: { title: string; fields: FieldDef<Values>[] }[] = [
    { title: 'Personal', fields: [
      { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name' },
      { name: 'email', label: 'Work email', type: 'email', required: true, hint: 'Used to link the employee\'s login' }, { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'date_of_birth', label: 'Date of birth', type: 'date' }, { name: 'gender', label: 'Gender', type: 'select', options: GENDERS },
      { name: 'marital_status', label: 'Marital status', type: 'select', options: opts(['single', 'married', 'other']) },
      { name: 'address', label: 'Address', span: 2 }, { name: 'city', label: 'City' }, { name: 'state', label: 'State' },
      { name: 'country', label: 'Country' }, { name: 'postal_code', label: 'Postal code' },
      { name: 'emergency_contact_name', label: 'Emergency contact' }, { name: 'emergency_contact_phone', label: 'Emergency phone', type: 'tel' },
    ] },
    { title: 'Employment', fields: [
      { name: 'employee_code', label: 'Employee code', placeholder: `Auto (${company?.employee_code_prefix}-0001)`, hint: employee ? undefined : 'Leave blank to auto-generate' },
      { name: 'status', label: 'Status', type: 'select', options: EMPLOYEE_STATUSES, required: true },
      { name: 'department_id', label: 'Department', type: 'select', options: departments.options },
      { name: 'designation_id', label: 'Designation', type: 'select', options: designations.options },
      { name: 'manager_id', label: 'Reporting manager', type: 'select', options: managers.options.filter((m) => m.value !== employee?.id) },
      { name: 'employment_type', label: 'Employment type', type: 'select', options: EMPLOYMENT_TYPES, required: true },
      { name: 'work_location', label: 'Work location' }, { name: 'joining_date', label: 'Joining date', type: 'date', required: true },
      { name: 'probation_end_date', label: 'Probation ends', type: 'date' }, { name: 'exit_date', label: 'Exit date', type: 'date' },
    ] },
    { title: `Compensation (${cur})`, fields: [
      { name: 'ctc_annual', label: 'Annual CTC', type: 'number', min: 0, span: 2 },
      { name: 'basic_monthly', label: 'Basic (monthly)', type: 'number', min: 0 }, { name: 'hra_monthly', label: 'HRA (monthly)', type: 'number', min: 0 },
      { name: 'allowances_monthly', label: 'Allowances (monthly)', type: 'number', min: 0 },
      { name: 'fixed_deductions_monthly', label: 'Other fixed deductions (monthly)', type: 'number', min: 0 },
    ] },
    { title: 'Statutory & bank', fields: [
      { name: 'pan_number', label: 'PAN', placeholder: 'ABCDE1234F' }, { name: 'bank_name', label: 'Bank name' },
      { name: 'bank_account_number', label: 'Account number' }, { name: 'bank_ifsc', label: 'IFSC', placeholder: 'HDFC0001234' },
    ] },
  ];
  const submit = form.handleSubmit(async (v) => {
    setError('');
    try {
      await save.mutateAsync(v);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  });
  return (
    <Modal open={open} onClose={onClose} size="xl" title={employee ? `Edit ${employee.full_name}` : 'Add employee'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="emp-form" loading={form.formState.isSubmitting}>{employee ? 'Save changes' : 'Create employee'}</Button></>}>
      <form id="emp-form" onSubmit={submit} noValidate className="space-y-6">
        {error && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>}
        {Object.keys(form.formState.errors).length > 0 && <p className="text-sm text-rose-600">Please fix the highlighted fields.</p>}
        {sections.map((s) => (
          <section key={s.title}>
            <h3 className="mb-3 border-b border-slate-100 pb-2 text-sm font-semibold text-slate-900">{s.title}</h3>
            <FormFields fields={s.fields} form={form} />
          </section>
        ))}
      </form>
    </Modal>
  );
}
