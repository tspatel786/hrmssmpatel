// /app/openings — every member sees the company's published openings, applies internally or refers someone (migration 1900).
import { Briefcase, CheckCircle2, MapPin, Send, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormModal, type FieldDef } from '@/components/FormModal';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, PageHeader, PageLoader } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { fmtDate, titleCase } from '@/lib/format';
import { useAction, useRpc } from '@/lib/hooks';

interface Opening {
  id: string; title: string; location: string | null; employment_type: string | null; work_mode: string | null; openings: number;
  closing_date: string | null; description: string; department: string | null; published_at: string | null; applied: boolean; my_referrals: number;
}

const referSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(60),
  last_name: z.string().trim().max(60).optional().or(z.literal('')),
  email: z.string().trim().email('Enter a valid email'),
  phone: z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone number'),
  note: z.string().trim().max(3000).optional().or(z.literal('')),
});
type Refer = z.infer<typeof referSchema>;
const referFields: FieldDef<Refer>[] = [
  { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name' },
  { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'phone', label: 'Phone', type: 'tel', required: true },
  { name: 'note', label: 'Why are they a good fit?', type: 'textarea', span: 2, rows: 3 },
];

export function InternalOpenings() {
  const { companyId } = useCompany();
  const q = useRpc<Opening[]>('internal_openings', companyId ? { p_company: companyId } : null);
  const me = useRpc<{ employee: { id: string } | null }>('my_dashboard', companyId ? { p_company: companyId } : null);
  const employeeId = me.data?.employee?.id;
  const [applying, setApplying] = useState<Opening | null>(null);
  const [referring, setReferring] = useState<Opening | null>(null);
  const [resume, setResume] = useState<File | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const apply = useAction(({ job, note }: { job: string; note: string }) => api.db.rpc('internal_apply', { p_job: job, p_note: note || null }),
    { success: 'Application sent to HR', onSuccess: () => setApplying(null) });

  const submitReferral = async (v: Refer) => {
    if (!referring || !companyId) return;
    let p_resume: Record<string, unknown> | null = null;
    if (resume) {
      if (resume.size > 5 * 1024 * 1024) throw new Error('Resume must be 5 MB or smaller');
      const safe = resume.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
      const path = `${companyId}/referrals/${crypto.randomUUID()}/${safe}`;
      await api.storage.upload('resumes', path, resume, resume.type || 'application/pdf');
      p_resume = { path, name: resume.name, size: resume.size, mime: resume.type || 'application/pdf' };
    }
    await api.db.rpc('refer_candidate', { p_job: referring.id, p_data: v, p_resume });
    void api.processEmails();
    toast.success(`Thanks! ${v.first_name} was referred for ${referring.title}`);
    setReferring(null);
    setResume(null);
    void q.refetch();
  };

  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const jobs = q.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Internal openings" description="Open positions in the company. Apply for a move yourself, or refer someone you know." />
      {!employeeId && <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">Your login is not linked to an employee record, so you can view openings but not apply or refer.</p>}
      {jobs.length === 0 ? (
        <EmptyState icon={<Briefcase className="h-6 w-6" />} title="No open positions right now" description="You'll get an email as soon as a new opening is published." />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2" data-testid="internal-openings">
          {jobs.map((j) => (
            <li key={j.id} className="card flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-display text-lg font-semibold text-slate-900">{j.title}</h2>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
                    {j.department && <span>{j.department}</span>}
                    {j.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{j.location}</span>}
                    {j.employment_type && <span>{titleCase(j.employment_type)}</span>}
                    {j.work_mode && <span>{titleCase(j.work_mode)}</span>}
                  </p>
                </div>
                {j.applied && <Badge tone="green"><CheckCircle2 className="h-3.5 w-3.5" /> Applied</Badge>}
              </div>
              <p className={`mt-3 whitespace-pre-line text-sm text-slate-600 ${open === j.id ? '' : 'line-clamp-3'}`}>{j.description}</p>
              <button type="button" className="mt-1 self-start text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpen(open === j.id ? null : j.id)}>
                {open === j.id ? 'Show less' : 'Read more'}
              </button>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4 text-xs text-slate-500">
                <span>{j.openings} position(s){j.closing_date ? ` · apply by ${fmtDate(j.closing_date)}` : ''}{j.my_referrals > 0 ? ` · you referred ${j.my_referrals}` : ''}</span>
                {employeeId && (
                  <span className="flex gap-2">
                    <Button variant="secondary" size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setReferring(j)}>Refer</Button>
                    {!j.applied && <Button size="sm" icon={<Send className="h-4 w-4" />} onClick={() => setApplying(j)}>Apply</Button>}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog open={!!applying} onClose={() => setApplying(null)} title={`Apply for ${applying?.title ?? ''}`}
        message="HR and the hiring manager will see your application with your current role. Your manager is not notified automatically."
        confirmLabel="Send application" loading={apply.isPending}
        input={{ label: 'Note to HR (optional)', multiline: true, placeholder: 'Why are you interested in this role?' }}
        onConfirm={(note) => applying && apply.mutate({ job: applying.id, note: note ?? '' })} />

      {referring && (
        <FormModal open onClose={() => { setReferring(null); setResume(null); }} title={`Refer someone for ${referring.title}`}
          description="They'll get an email confirming the application. HR keeps you posted." schema={referSchema} fields={referFields}
          defaultValues={{ first_name: '', last_name: '', email: '', phone: '', note: '' }} onSubmit={submitReferral} submitLabel="Submit referral" size="md">
          <label className="mt-4 block text-sm">
            <span className="label">Resume (optional, PDF or Word, max 5 MB)</span>
            <input type="file" accept=".pdf,.doc,.docx" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2"
              onChange={(e) => setResume(e.target.files?.[0] ?? null)} />
          </label>
        </FormModal>
      )}
    </div>
  );
}
