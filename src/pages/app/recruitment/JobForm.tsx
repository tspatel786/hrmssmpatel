import { z } from 'zod';
import { clean, FormModal, type FieldDef } from '@/components/FormModal';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { EMPLOYMENT_TYPES, opts, WORK_MODES } from '@/lib/constants';
import { useAction } from '@/lib/hooks';
import { useDepartments, useDesignations, useMembers } from '@/lib/lookups';
import { optDate, optId, optNum, optStr, reqNum, reqStr, tags } from '@/lib/schemas';

export interface Job {
  id: string; company_id: string; requisition_id: string | null; title: string; department_id: string | null; department_name: string | null;
  designation_id: string | null; designation_title: string | null; location: string; employment_type: string; work_mode: string;
  experience_min: number; experience_max: number | null; salary_min: number | null; salary_max: number | null; show_salary: boolean; internal_visible?: boolean;
  openings: number; description: string; responsibilities: string | null; requirements: string | null; benefits: string | null;
  skills: string[]; status: string; published_at: string | null; closing_date: string | null; hiring_manager_id: string | null;
  hiring_manager_name: string | null; applications_count: number; active_count: number; hired_count: number; created_at: string;
}

const schema = z.object({
  title: reqStr(3, 120, 'Title'),
  department_id: optId,
  designation_id: optId,
  location: reqStr(2, 120, 'Location'),
  employment_type: z.string(),
  work_mode: z.string(),
  experience_min: reqNum(0, 60, 'Required'),
  experience_max: optNum(60),
  salary_min: optNum(),
  salary_max: optNum(),
  show_salary: z.boolean().default(false),
  internal_visible: z.boolean().default(true),
  openings: reqNum(1, 500, 'Required'),
  hiring_manager_id: optId,
  closing_date: optDate,
  status: z.string(),
  skills: tags,
  description: reqStr(20, 20000, 'Description'),
  responsibilities: optStr(10000),
  requirements: optStr(10000),
  benefits: optStr(10000),
})
  .refine((v) => v.experience_max == null || v.experience_max >= v.experience_min, { message: 'Must be ≥ minimum', path: ['experience_max'] })
  .refine((v) => v.salary_min == null || v.salary_max == null || v.salary_max >= v.salary_min, { message: 'Must be ≥ minimum', path: ['salary_max'] });
export type JobValues = z.infer<typeof schema>;

export function JobForm({ open, onClose, job, prefill, onSaved }: {
  open: boolean; onClose: () => void; job?: Job | null; prefill?: Partial<JobValues> & { requisition_id?: string }; onSaved?: (id: string) => void;
}) {
  const { companyId, company } = useCompany();
  const departments = useDepartments();
  const designations = useDesignations();
  const members = useMembers();
  const save = useAction(async (v: JobValues) => {
    const data = clean({ ...v, skills: v.skills.filter(Boolean) } as Record<string, unknown>);
    if (job) return (await api.db.update<{ id: string }>('jobs', job.id, data)).id;
    return (await api.db.insert<{ id: string }>('jobs', { ...data, company_id: companyId, requisition_id: prefill?.requisition_id ?? null })).id;
  }, { success: job ? 'Job updated' : 'Job created', onSuccess: (id) => onSaved?.(id) });

  const fields: FieldDef<JobValues>[] = [
    { name: 'title', label: 'Job title', required: true, span: 2 },
    { name: 'department_id', label: 'Department', type: 'select', options: departments.options },
    { name: 'designation_id', label: 'Designation', type: 'select', options: designations.options },
    { name: 'location', label: 'Location', required: true },
    { name: 'work_mode', label: 'Work mode', type: 'select', options: WORK_MODES, required: true },
    { name: 'employment_type', label: 'Employment type', type: 'select', options: EMPLOYMENT_TYPES, required: true },
    { name: 'openings', label: 'Openings', type: 'number', required: true, min: 1 },
    { name: 'experience_min', label: 'Min experience (yrs)', type: 'number', required: true, min: 0, step: '0.5' },
    { name: 'experience_max', label: 'Max experience (yrs)', type: 'number', min: 0, step: '0.5' },
    { name: 'salary_min', label: `Salary min (${company?.currency}/yr)`, type: 'number', min: 0 },
    { name: 'salary_max', label: `Salary max (${company?.currency}/yr)`, type: 'number', min: 0 },
    { name: 'show_salary', label: 'Show salary range on careers page', type: 'checkbox', span: 2 },
    { name: 'internal_visible', label: 'Show to employees as an internal opening (everyone is emailed when it is published)', type: 'checkbox', span: 2 },
    { name: 'hiring_manager_id', label: 'Hiring manager', type: 'select', options: members.options },
    { name: 'closing_date', label: 'Closing date', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', options: opts(['draft', 'published', 'on_hold', 'closed']), required: true, hint: 'Published jobs appear on your careers page' },
    { name: 'skills', label: 'Skills', type: 'tags', placeholder: 'React, TypeScript, …', hint: 'Comma separated' },
    { name: 'description', label: 'About the role', type: 'textarea', required: true, rows: 5 },
    { name: 'responsibilities', label: 'Responsibilities', type: 'textarea' },
    { name: 'requirements', label: 'Requirements', type: 'textarea' },
    { name: 'benefits', label: 'Benefits', type: 'textarea', rows: 3 },
  ];
  const defaults = job
    ? { ...job, skills: job.skills ?? [] }
    : { employment_type: 'full_time', work_mode: 'onsite', status: 'draft', openings: 1, experience_min: 0, location: company?.city || 'Head Office', show_salary: false, internal_visible: true, skills: [], ...prefill };
  return (
    <FormModal open={open} onClose={onClose} size="xl" title={job ? 'Edit job opening' : 'New job opening'} schema={schema} fields={fields}
      defaultValues={defaults as never} onSubmit={(v) => save.mutateAsync(v)} submitLabel={job ? 'Save changes' : 'Create job'} />
  );
}
