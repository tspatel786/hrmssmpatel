import { FileText, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { DataTable, type Column } from '@/components/DataTable';
import { clean, FormModal, type FieldDef } from '@/components/FormModal';
import { Avatar, Badge, Button, Field, PageHeader } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { RESUME_MIME, SOURCES, STAGES, stageInfo } from '@/lib/constants';
import { fileSize, fmtRelative } from '@/lib/format';
import { useAction, useTable } from '@/lib/hooks';
import { useJobs } from '@/lib/lookups';
import { optNum, optStr, optUrl, reqStr, tags } from '@/lib/schemas';
import { BulkCandidateActions } from './BulkActions';

export interface Candidate {
  id: string; company_id: string; first_name: string; last_name: string; full_name: string; email: string; phone: string | null;
  current_location: string | null; current_company: string | null; current_title: string | null; experience_years: number | null;
  current_ctc: number | null; expected_ctc: number | null; notice_period_days: number | null; linkedin_url: string | null;
  portfolio_url: string | null; skills: string[]; tags: string[]; highest_qualification?: string | null; institution?: string | null; graduation_year?: number | null; source: string; notes: string | null; applications_count: number;
  latest_stage: string | null; latest_job_title: string | null; last_applied_at: string | null; has_resume: boolean; created_at: string;
}
export interface Application {
  id: string; company_id: string; job_id: string; candidate_id: string; stage: string; cover_letter: string | null; source: string;
  rating: number | null; rejection_reason: string | null; applied_at: string; stage_changed_at: string; candidate_name: string;
  candidate_email: string; candidate_phone: string | null; experience_years: number | null; current_title: string | null;
  current_company: string | null; current_location: string | null; skills: string[]; expected_ctc: number | null;
  notice_period_days: number | null; job_title: string; department_id: string | null; department_name: string | null;
  interviews_count: number; avg_feedback_rating: number | null; resume_document_id: string | null;
}

const schema = z.object({
  first_name: reqStr(1, 60, 'First name'),
  last_name: optStr(60),
  email: z.string().trim().email('Enter a valid email'),
  phone: z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone number').or(z.literal('')).optional().nullable(),
  job_id: z.string().optional().nullable(),
  source: z.string(),
  current_title: optStr(100),
  current_company: optStr(100),
  current_location: optStr(80),
  experience_years: optNum(60),
  expected_ctc: optNum(),
  notice_period_days: optNum(365),
  linkedin_url: optUrl,
  skills: tags,
  notes: optStr(4000),
});
type Values = z.infer<typeof schema>;

/** Manually add a candidate (optionally to a job) with resume upload. */
export function AddCandidateModal({ open, onClose, jobId }: { open: boolean; onClose: () => void; jobId?: string }) {
  const { companyId } = useCompany();
  const jobs = useJobs();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const add = useAction(async (v: Values) => {
    const { job_id, ...cand } = clean(v as Record<string, unknown>) as Values;
    const email = cand.email.toLowerCase();
    const existing = await api.db.list<{ id: string }>({ table: 'candidates', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'email', op: 'eq', value: email }], count: false });
    const candidateId = existing.rows[0]?.id ?? (await api.db.insert<{ id: string }>('candidates', { ...cand, email, skills: (cand.skills ?? []).filter(Boolean), company_id: companyId })).id;
    let applicationId: string | null = null;
    const targetJob = jobId ?? job_id;
    if (targetJob) applicationId = (await api.db.insert<{ id: string }>('applications', { company_id: companyId, job_id: targetJob, candidate_id: candidateId, source: cand.source, stage: 'applied' })).id;
    if (file) {
      const path = `${companyId}/candidates/${candidateId}/${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
      await api.storage.upload('resumes', path, file, file.type || 'application/pdf');
      await api.db.insert('candidate_documents', { company_id: companyId, candidate_id: candidateId, application_id: applicationId, doc_type: 'resume', file_name: file.name, storage_bucket: 'resumes', storage_path: path, mime_type: file.type, size_bytes: file.size });
    }
    return candidateId;
  }, { success: 'Candidate added', onSuccess: (id) => { setFile(null); if (!jobId) navigate(`/app/recruitment/candidates/${id}`); } });

  const fields: FieldDef<Values>[] = [
    { name: 'first_name', label: 'First name', required: true },
    { name: 'last_name', label: 'Last name' },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'job_id', label: 'Apply to job', type: 'select', options: jobs.options, hidden: !!jobId, hint: 'Optional — adds the candidate to the job pipeline' },
    { name: 'source', label: 'Source', type: 'select', options: SOURCES, required: true },
    { name: 'current_title', label: 'Current title' },
    { name: 'current_company', label: 'Current company' },
    { name: 'current_location', label: 'Location' },
    { name: 'experience_years', label: 'Experience (years)', type: 'number', min: 0, step: '0.5' },
    { name: 'expected_ctc', label: 'Expected CTC', type: 'number', min: 0 },
    { name: 'notice_period_days', label: 'Notice period (days)', type: 'number', min: 0 },
    { name: 'linkedin_url', label: 'LinkedIn URL', type: 'url', span: 2 },
    { name: 'skills', label: 'Skills', type: 'tags', span: 2, hint: 'Comma separated' },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 3 },
  ];
  return (
    <FormModal open={open} onClose={() => { setFile(null); onClose(); }} title="Add candidate" size="xl" schema={schema} fields={fields}
      defaultValues={{ source: 'direct', skills: [], job_id: jobId ?? '' } as never} onSubmit={(v) => add.mutateAsync(v)} submitLabel="Add candidate">
      <Field label="Resume" className="mt-4" error={fileError} hint="PDF or Word, max 5 MB">
        <input type="file" accept=".pdf,.doc,.docx" className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            setFileError('');
            if (!f) return setFile(null);
            if (!RESUME_MIME.includes(f.type) && !/\.(pdf|docx?)$/i.test(f.name)) return setFileError('Upload a PDF or Word document');
            if (f.size > 5242880) return setFileError('File must be 5 MB or smaller');
            setFile(f);
          }} />
        {file && <p className="hint">{file.name} · {fileSize(file.size)}</p>}
      </Field>
    </FormModal>
  );
}

export function Candidates() {
  const { companyId, can } = useCompany();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const table = useTable({
    table: 'v_candidates', companyId, searchColumns: ['full_name', 'email', 'current_title', 'current_company', 'skills', 'phone'],
    defaultSort: { column: 'created_at', ascending: false },
  });
  const columns: Column<Candidate>[] = [
    { key: 'full_name', header: 'Candidate', sortable: true, render: (c) => (
      <div className="flex items-center gap-3"><Avatar name={c.full_name} size="sm" /><div className="min-w-0"><p className="truncate font-medium text-slate-900">{c.full_name}</p><p className="truncate text-xs text-slate-500">{c.email}</p></div></div>
    ), csv: (c) => c.full_name },
    { key: 'email', header: 'Email', hideOnMobile: true, render: (c) => c.email, className: 'hidden' },
    { key: 'current_title', header: 'Current role', hideOnMobile: true, render: (c) => <span>{c.current_title ?? '—'}{c.current_company && <span className="block text-xs text-slate-500">{c.current_company}</span>}</span> },
    { key: 'experience_years', header: 'Exp.', sortable: true, render: (c) => (c.experience_years != null ? `${c.experience_years} yrs` : '—') },
    { key: 'skills', header: 'Skills', hideOnMobile: true, render: (c) => <div className="flex max-w-[220px] flex-wrap gap-1">{c.skills.slice(0, 3).map((s) => <Badge key={s}>{s}</Badge>)}{c.skills.length > 3 && <Badge>+{c.skills.length - 3}</Badge>}</div> },
    { key: 'latest_stage', header: 'Latest stage', render: (c) => c.latest_stage ? <div><Badge tone={stageInfo(c.latest_stage).tone} dot>{stageInfo(c.latest_stage).label}</Badge><p className="mt-0.5 max-w-[180px] truncate text-xs text-slate-500">{c.latest_job_title}</p></div> : <span className="text-slate-400">No application</span> },
    { key: 'tags', header: 'Tags', hideOnMobile: true, render: (c) => (c.tags.length ? <div className="flex max-w-[160px] flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} tone="violet">{t}</Badge>)}</div> : '—'), csv: (c) => c.tags.join('; ') },
    { key: 'source', header: 'Source', hideOnMobile: true, render: (c) => <span className="capitalize">{c.source.replace('_', ' ')}</span> },
    { key: 'has_resume', header: 'Resume', hideOnMobile: true, render: (c) => (c.has_resume ? <FileText className="h-4 w-4 text-brand-600" aria-label="Has resume" /> : '—'), csv: (c) => (c.has_resume ? 'yes' : 'no') },
    { key: 'created_at', header: 'Added', sortable: true, hideOnMobile: true, render: (c) => fmtRelative(c.created_at) },
  ];
  return (
    <>
      <PageHeader title="Candidates" description="Your talent database: every applicant across all jobs, with resumes and history."
        actions={can('candidates.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add candidate</Button>} />
      <DataTable table={table} columns={columns.filter((c) => c.key !== 'email')} searchPlaceholder="Search name, email, skills…" exportName="candidates"
        onRowClick={(c) => navigate(`/app/recruitment/candidates/${c.id}`)}
        bulkActions={can('candidates.manage') ? (sel, clear) => <BulkCandidateActions selected={sel} clear={clear} /> : undefined}
        filters={[{ key: 'latest_stage', label: 'Stages', options: STAGES.map((s) => ({ value: s.value, label: s.label })) }, { key: 'source', label: 'Sources', options: SOURCES }]}
        mobileCard={(c) => (
          <div className="flex items-center gap-3"><Avatar name={c.full_name} size="sm" /><div className="min-w-0 flex-1"><p className="font-medium">{c.full_name}</p><p className="truncate text-xs text-slate-500">{c.current_title ?? c.email}</p></div>{c.latest_stage && <Badge tone={stageInfo(c.latest_stage).tone}>{stageInfo(c.latest_stage).label}</Badge>}</div>
        )}
        empty={{ icon: <Users className="h-6 w-6" />, title: 'No candidates yet', description: 'Candidates appear here when they apply through your careers page, or you can add them manually.' }} />
      {adding && <AddCandidateModal open onClose={() => setAdding(false)} />}
    </>
  );
}
