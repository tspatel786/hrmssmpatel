import { addDays, format } from 'date-fns';
import { z } from 'zod';
import { clean, FormModal, type FieldDef } from '@/components/FormModal';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { EMPLOYMENT_TYPES } from '@/lib/constants';
import { fmtMoney } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useDepartments, useDesignations, useEmployeeOptions } from '@/lib/lookups';
import { optId, optStr, reqDate, reqNum } from '@/lib/schemas';

export interface Offer {
  id: string; company_id: string; offer_number: string; application_id: string; candidate_id: string; job_id: string;
  designation_id: string | null; department_id: string | null; reporting_manager_id: string | null; employment_type: string;
  work_location: string | null; ctc_annual: number; basic_monthly: number; hra_monthly: number; allowances_monthly: number;
  joining_date: string; expiry_date: string; probation_months: number; additional_terms: string | null; status: string;
  pdf_path: string | null; token_expires_at: string | null; sent_at: string | null; viewed_at: string | null; responded_at: string | null;
  candidate_signature: string | null; decline_reason: string | null; approved_by: string | null; approved_at: string | null;
  created_by: string; created_at: string; candidate_name: string; candidate_email: string; job_title: string;
  designation_title: string | null; department_name: string | null; reporting_manager_name: string | null; created_by_name: string | null; approved_by_name: string | null;
}

const today = () => format(new Date(), 'yyyy-MM-dd');
const schema = z.object({
  designation_id: optId,
  department_id: optId,
  reporting_manager_id: optId,
  employment_type: z.string(),
  work_location: optStr(120),
  ctc_annual: reqNum(1, 1e10, 'Annual CTC is required'),
  basic_monthly: reqNum(0, 1e9, 'Required'),
  hra_monthly: reqNum(0, 1e9, 'Required'),
  allowances_monthly: reqNum(0, 1e9, 'Required'),
  joining_date: reqDate('Joining date').refine((v) => v >= today(), 'Cannot be in the past'),
  expiry_date: reqDate('Expiry date').refine((v) => v >= today(), 'Cannot be in the past'),
  probation_months: reqNum(0, 24, 'Required'),
  additional_terms: optStr(4000),
})
  .refine((v) => v.expiry_date <= v.joining_date, { message: 'Offer should expire on or before the joining date', path: ['expiry_date'] })
  .refine((v) => (v.basic_monthly + v.hra_monthly + v.allowances_monthly) * 12 <= v.ctc_annual * 1.0001, {
    message: 'Monthly components × 12 exceed the annual CTC', path: ['allowances_monthly'],
  });
type Values = z.infer<typeof schema>;

/** Splits CTC into a typical structure: 40% basic, 20% (of CTC) HRA, rest allowances (after ~5% employer cost). */
export function suggestBreakup(ctc: number) {
  const monthly = (ctc * 0.95) / 12;
  const basic = Math.round(ctc * 0.4 / 12);
  const hra = Math.round(ctc * 0.2 / 12);
  return { basic_monthly: basic, hra_monthly: hra, allowances_monthly: Math.max(0, Math.round(monthly - basic - hra)) };
}

export function OfferFormModal({ open, onClose, application, offer, onSaved }: {
  open: boolean; onClose: () => void; onSaved?: (id: string) => void;
  application?: { id: string; job_id: string; job_title: string; candidate_name: string; department_id: string | null; expected_ctc?: number | null };
  offer?: Offer | null;
}) {
  const { companyId, company } = useCompany();
  const designations = useDesignations();
  const departments = useDepartments();
  const employees = useEmployeeOptions();
  const save = useAction(async (v: Values) => {
    const data = clean(v as Record<string, unknown>);
    if (offer) return (await api.db.update<{ id: string }>('offers', offer.id, data)).id;
    return (await api.db.insert<{ id: string }>('offers', { ...data, company_id: companyId, application_id: application!.id })).id;
  }, { success: offer ? 'Offer updated' : 'Offer drafted', onSuccess: (id) => onSaved?.(id) });

  const ctc = offer?.ctc_annual ?? application?.expected_ctc ?? 1200000;
  const defaults = offer ? { ...offer } : {
    department_id: application?.department_id ?? '', employment_type: 'full_time', ctc_annual: ctc, ...suggestBreakup(ctc),
    joining_date: format(addDays(new Date(), 30), 'yyyy-MM-dd'),
    expiry_date: format(addDays(new Date(), company?.offer_validity_days ?? 7), 'yyyy-MM-dd'),
    probation_months: 6, work_location: company?.city ?? '',
  };
  const cur = company?.currency ?? 'INR';
  const fields: FieldDef<Values>[] = [
    { name: 'designation_id', label: 'Designation', type: 'select', options: designations.options },
    { name: 'department_id', label: 'Department', type: 'select', options: departments.options },
    { name: 'employment_type', label: 'Employment type', type: 'select', options: EMPLOYMENT_TYPES, required: true },
    { name: 'reporting_manager_id', label: 'Reporting manager', type: 'select', options: employees.options },
    { name: 'work_location', label: 'Work location' },
    { name: 'probation_months', label: 'Probation (months)', type: 'number', required: true, min: 0, max: 24 },
    { name: 'ctc_annual', label: `Annual CTC (${cur})`, type: 'number', required: true, min: 1, span: 2, hint: `e.g. ${fmtMoney(ctc, cur)}` },
    { name: 'basic_monthly', label: 'Basic (monthly)', type: 'number', required: true, min: 0 },
    { name: 'hra_monthly', label: 'HRA (monthly)', type: 'number', required: true, min: 0 },
    { name: 'allowances_monthly', label: 'Allowances (monthly)', type: 'number', required: true, min: 0 },
    { name: 'joining_date', label: 'Joining date', type: 'date', required: true },
    { name: 'expiry_date', label: 'Offer valid until', type: 'date', required: true },
    { name: 'additional_terms', label: 'Additional terms', type: 'textarea', rows: 3 },
  ];
  return (
    <FormModal open={open} onClose={onClose} size="xl" title={offer ? `Edit offer ${offer.offer_number}` : 'Create offer'}
      description={offer ? `${offer.candidate_name} · ${offer.job_title}` : `${application?.candidate_name} · ${application?.job_title}`}
      schema={schema} fields={fields} defaultValues={defaults as never} onSubmit={(v) => save.mutateAsync(v)} submitLabel={offer ? 'Save changes' : 'Save draft'} />
  );
}
