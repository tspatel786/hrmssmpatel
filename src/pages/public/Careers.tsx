import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Briefcase, Building2, CheckCircle2, Clock, FileUp, Globe, IndianRupee, MapPin, Search, Upload } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import { z } from 'zod';
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageLoader, Pagination, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/backend';
import { config } from '@/lib/config';
import { RESUME_MIME } from '@/lib/constants';
import { fileSize, fmtMoney, fmtRelative, titleCase } from '@/lib/format';

interface PublicCompany {
  id: string; name: string; slug: string; logo_url: string | null; primary_color: string; tagline: string | null; about: string | null;
  website: string | null; city: string | null; country: string | null;
}
interface PublicJob {
  id: string; title: string; department: string | null; location: string; employment_type: string; work_mode: string;
  experience_min: number; experience_max: number | null; salary_min: number | null; salary_max: number | null; currency: string;
  skills: string[]; published_at: string; closing_date: string | null; description?: string; responsibilities?: string | null;
  requirements?: string | null; benefits?: string | null; openings?: number;
}

function useCompanyPublic(slug: string) {
  return useQuery({ queryKey: ['public-company', slug], queryFn: () => api.db.rpc<PublicCompany | null>('public_company', { p_slug: slug }) });
}

function CareersShell({ company, children }: { company: PublicCompany; children: React.ReactNode }) {
  const style = { '--brand': company.primary_color } as CSSProperties;
  return (
    <div className="min-h-screen bg-slate-50" style={style}>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link to={`/careers/${company.slug}`} className="flex items-center gap-3">
            {company.logo_url ? <img src={company.logo_url} alt="" className="h-9 w-9 rounded-lg object-cover" /> : (
              <span className="flex h-9 w-9 items-center justify-center rounded-lg text-white" style={{ background: company.primary_color }}><Building2 className="h-5 w-5" /></span>
            )}
            <span className="font-semibold text-slate-900">{company.name} <span className="font-normal text-slate-500">Careers</span></span>
          </Link>
          {company.website && <a href={company.website} target="_blank" rel="noreferrer" className="btn-ghost text-sm"><Globe className="h-4 w-4" /> Website</a>}
        </div>
      </header>
      {children}
      <footer className="py-10 text-center text-xs text-slate-400">Powered by {config.appName} · Your data is processed only for recruitment purposes.</footer>
    </div>
  );
}

const salary = (j: PublicJob) =>
  j.salary_min || j.salary_max ? `${fmtMoney(j.salary_min ?? j.salary_max, j.currency, true)}${j.salary_max && j.salary_min ? ` – ${fmtMoney(j.salary_max, j.currency, true)}` : ''} / yr` : null;
const experience = (j: PublicJob) => `${j.experience_min}${j.experience_max ? `–${j.experience_max}` : '+'} yrs`;

export function CareersHome() {
  const { slug = '' } = useParams();
  const company = useCompanyPublic(slug);
  const jobs = useQuery({ queryKey: ['public-jobs', slug], queryFn: () => api.db.rpc<PublicJob[]>('public_jobs', { p_slug: slug }), enabled: !!company.data });
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [loc, setLoc] = useState('');
  const [mode, setMode] = useState('');
  const [page, setPage] = useState(1);
  const all = useMemo(() => jobs.data ?? [], [jobs.data]);
  const filtered = useMemo(() => all.filter((j) =>
    (!q || `${j.title} ${j.skills.join(' ')} ${j.department ?? ''}`.toLowerCase().includes(q.toLowerCase())) &&
    (!dept || j.department === dept) && (!loc || j.location === loc) && (!mode || j.work_mode === mode)), [all, q, dept, loc, mode]);
  const pageSize = 10;
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter(Boolean) as string[])].sort().map((v) => ({ value: v, label: v }));

  if (company.isLoading) return <PageLoader />;
  if (company.isError) return <ErrorState error={company.error} onRetry={() => company.refetch()} />;
  if (!company.data) {
    return <div className="flex min-h-screen items-center justify-center"><EmptyState title="Careers page not found" description="This company does not exist or its careers page is disabled." action={<Link to="/" className="btn-secondary">Go home</Link>} /></div>;
  }
  const c = company.data;
  return (
    <CareersShell company={c}>
      <section className="relative overflow-hidden text-white" style={{ background: `linear-gradient(135deg, ${c.primary_color}, #0f172a)` }}>
        <div className="mx-auto max-w-5xl px-6 py-16">
          <p className="text-sm font-medium uppercase tracking-wider text-white/70">Careers at {c.name}</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-bold sm:text-4xl">{c.tagline || 'Join our team'}</h1>
          {c.about && <p className="mt-4 max-w-2xl text-white/80">{c.about}</p>}
          <p className="mt-6 text-sm text-white/70">{all.length} open position{all.length === 1 ? '' : 's'}{c.city ? ` · ${c.city}` : ''}</p>
        </div>
      </section>
      <main className="relative z-10 mx-auto -mt-8 max-w-5xl px-6">
        <div className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="input pl-9" placeholder="Search roles or skills" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search jobs" />
          </div>
          <Select aria-label="Department" value={dept} onChange={(e) => { setDept(e.target.value); setPage(1); }} options={uniq(all.map((j) => j.department))} placeholder="All departments" />
          <Select aria-label="Location" value={loc} onChange={(e) => { setLoc(e.target.value); setPage(1); }} options={uniq(all.map((j) => j.location))} placeholder="All locations" />
          <Select aria-label="Work mode" value={mode} onChange={(e) => { setMode(e.target.value); setPage(1); }} options={[{ value: 'onsite', label: 'On-site' }, { value: 'remote', label: 'Remote' }, { value: 'hybrid', label: 'Hybrid' }]} placeholder="Any work mode" />
        </div>
        <div className="mt-6 space-y-3">
          {jobs.isLoading && <PageLoader label="Loading open roles…" />}
          {jobs.isError && <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />}
          {!jobs.isLoading && filtered.length === 0 && (
            <div className="card"><EmptyState icon={<Briefcase className="h-6 w-6" />} title={all.length ? 'No roles match your filters' : 'No open positions right now'} description={all.length ? 'Try clearing your filters.' : 'Check back soon — we are always growing.'} /></div>
          )}
          {filtered.slice((page - 1) * pageSize, page * pageSize).map((j) => (
            <Link key={j.id} to={`/careers/${c.slug}/jobs/${j.id}`} className="card group block p-5 transition hover:-translate-y-0.5 hover:shadow-pop">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 group-hover:underline" style={{ textDecorationColor: c.primary_color }}>{j.title}</h2>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
                    {j.department && <span className="flex items-center gap-1"><Briefcase className="h-4 w-4" />{j.department}</span>}
                    <span className="flex items-center gap-1"><MapPin className="h-4 w-4" />{j.location}</span>
                    <span className="flex items-center gap-1"><Clock className="h-4 w-4" />{experience(j)}</span>
                    {salary(j) && <span className="flex items-center gap-1"><IndianRupee className="h-4 w-4" />{salary(j)}</span>}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge tone="blue">{titleCase(j.employment_type)}</Badge>
                    <Badge tone="violet">{titleCase(j.work_mode)}</Badge>
                    {j.skills.slice(0, 4).map((s) => <Badge key={s}>{s}</Badge>)}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-slate-400">Posted {fmtRelative(j.published_at)}</span>
              </div>
            </Link>
          ))}
        </div>
        {filtered.length > pageSize && <div className="card mt-4"><Pagination page={page} pageSize={pageSize} total={filtered.length} onPage={setPage} /></div>}
      </main>
    </CareersShell>
  );
}

const applySchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(60),
  last_name: z.string().trim().max(60).optional(),
  email: z.string().trim().email('Enter a valid email').max(254),
  phone: z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone number'),
  current_location: z.string().trim().max(80).optional(),
  current_company: z.string().trim().max(100).optional(),
  current_title: z.string().trim().max(100).optional(),
  experience_years: z.string().optional().refine((v) => !v || (Number(v) >= 0 && Number(v) <= 60), 'Between 0 and 60'),
  expected_ctc: z.string().optional().refine((v) => !v || Number(v) >= 0, 'Must be a positive number'),
  notice_period_days: z.string().optional().refine((v) => !v || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 365), '0–365 days'),
  linkedin_url: z.string().trim().url('Enter a full URL (https://…)').or(z.literal('')).optional(),
  highest_qualification: z.string().trim().max(100).optional(),
  institution: z.string().trim().max(150).optional(),
  graduation_year: z.string().optional().refine((v) => !v || (/^\d{4}$/.test(v) && Number(v) >= 1950 && Number(v) <= new Date().getFullYear() + 6), 'Enter a valid year'),
  skills: z.string().max(500).optional(),
  cover_letter: z.string().max(5000, 'Max 5000 characters').optional(),
  consent: z.literal(true, { errorMap: () => ({ message: 'Please accept to continue' }) }),
  website: z.string().max(0).optional(), // honeypot
});
type ApplyValues = z.infer<typeof applySchema>;

export function CareersJob() {
  const { slug = '', jobId = '' } = useParams();
  const company = useCompanyPublic(slug);
  const job = useQuery({ queryKey: ['public-job', slug, jobId], queryFn: () => api.db.rpc<PublicJob | null>('public_job', { p_slug: slug, p_job: jobId }), enabled: !!company.data });
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState<{ job_title: string; application_id: string; reference_no?: string } | null>(null);
  const form = useForm<ApplyValues>({ resolver: zodResolver(applySchema) });
  const e = form.formState.errors;

  if (company.isLoading || job.isLoading) return <PageLoader />;
  if (!company.data || !job.data) {
    return <div className="flex min-h-screen items-center justify-center"><EmptyState title="This position is no longer available" description="It may have been filled or closed." action={<Link to={`/careers/${slug}`} className="btn-secondary">See all openings</Link>} /></div>;
  }
  const c = company.data;
  const j = job.data;

  const pickFile = (f: File | undefined) => {
    setFileError('');
    if (!f) return;
    if (!RESUME_MIME.includes(f.type) && !/\.(pdf|docx?)$/i.test(f.name)) { setFileError('Upload a PDF or Word document'); return; }
    if (f.size > 5 * 1024 * 1024) { setFileError('File must be 5 MB or smaller'); return; }
    setFile(f);
  };

  const onSubmit = form.handleSubmit(async (v) => {
    setSubmitError('');
    if (!file) { setFileError('Please attach your resume'); return; }
    if (v.website) return; // bot
    try {
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
      const path = `${c.id}/incoming/${crypto.randomUUID()}/${safeName}`;
      const mime = file.type || (safeName.endsWith('.pdf') ? 'application/pdf' : 'application/msword');
      await api.storage.upload('resumes', path, file, mime);
      const { consent: _c, website: _w, ...data } = v;
      void _c; void _w;
      const res = await api.db.rpc<{ job_title: string; application_id: string; reference_no?: string }>('public_submit_application', {
        p_slug: slug, p_job: jobId, p_data: data, p_resume: { path, name: file.name, size: file.size, mime },
      });
      void api.processEmails();
      setDone(res);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setSubmitError((err as Error).message);
    }
  });

  if (done) {
    return (
      <CareersShell company={c}>
        <div className="mx-auto max-w-xl px-6 py-20 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><CheckCircle2 className="h-8 w-8" /></span>
          <h1 className="mt-5 text-2xl font-semibold">Application submitted!</h1>
          <p className="mt-2 text-slate-600">Thank you for applying for <strong>{done.job_title}</strong> at {c.name}. A confirmation email is on its way, and our team will be in touch.</p>
          <p className="mt-5 inline-block rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">Reference number{' '}
            <strong className="font-mono text-slate-900" data-testid="application-ref">{done.reference_no ?? `APP-${done.application_id.replace(/-/g, '').slice(0, 8).toUpperCase()}`}</strong></p>
          <p className="mt-2 text-xs text-slate-500">Keep this number for any questions about your application.</p>
          <Link to={`/careers/${c.slug}`} className="btn-secondary mt-8">Browse more roles</Link>
        </div>
      </CareersShell>
    );
  }

  const section = (title: string, body?: string | null) => body ? (
    <div className="mt-8">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="mt-3 whitespace-pre-line text-slate-700">{body}</div>
    </div>
  ) : null;

  return (
    <CareersShell company={c}>
      <div className="mx-auto max-w-5xl px-6 py-8">
        <Link to={`/careers/${c.slug}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> All openings</Link>
        <div className="mt-4 grid gap-8 lg:grid-cols-[1fr_400px]">
          <article className="card p-6 sm:p-8">
            <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{j.title}</h1>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-500">
              {j.department && <span className="flex items-center gap-1"><Briefcase className="h-4 w-4" />{j.department}</span>}
              <span className="flex items-center gap-1"><MapPin className="h-4 w-4" />{j.location} · {titleCase(j.work_mode)}</span>
              <span className="flex items-center gap-1"><Clock className="h-4 w-4" />{experience(j)}</span>
              {salary(j) && <span className="flex items-center gap-1"><IndianRupee className="h-4 w-4" />{salary(j)}</span>}
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">{j.skills.map((s) => <Badge key={s} tone="blue">{s}</Badge>)}</div>
            {section('About the role', j.description)}
            {section('Responsibilities', j.responsibilities)}
            {section('Requirements', j.requirements)}
            {section('Benefits', j.benefits)}
          </article>
          <aside>
            <form onSubmit={onSubmit} className="card space-y-4 p-6 lg:sticky lg:top-6" noValidate>
              <h2 className="text-lg font-semibold">Apply for this role</h2>
              <p className="-mt-2 text-sm text-slate-500">No account needed. Takes about 2 minutes.</p>
              {submitError && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{submitError}</div>}
              <div className="grid grid-cols-2 gap-3">
                <Field label="First name" required error={e.first_name?.message} htmlFor="fn"><Input id="fn" autoComplete="given-name" invalid={!!e.first_name} {...form.register('first_name')} /></Field>
                <Field label="Last name" error={e.last_name?.message} htmlFor="ln"><Input id="ln" autoComplete="family-name" {...form.register('last_name')} /></Field>
              </div>
              <Field label="Email" required error={e.email?.message} htmlFor="em"><Input id="em" type="email" autoComplete="email" invalid={!!e.email} {...form.register('email')} /></Field>
              <Field label="Phone" required error={e.phone?.message} htmlFor="ph"><Input id="ph" type="tel" autoComplete="tel" invalid={!!e.phone} {...form.register('phone')} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Experience (yrs)" error={e.experience_years?.message} htmlFor="ex"><Input id="ex" type="number" min={0} max={60} step="0.5" {...form.register('experience_years')} /></Field>
                <Field label="Notice (days)" error={e.notice_period_days?.message} htmlFor="np"><Input id="np" type="number" min={0} max={365} {...form.register('notice_period_days')} /></Field>
              </div>
              <Field label="Current title" htmlFor="ct"><Input id="ct" {...form.register('current_title')} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Current company" htmlFor="cc"><Input id="cc" {...form.register('current_company')} /></Field>
                <Field label="Location" htmlFor="cl"><Input id="cl" {...form.register('current_location')} /></Field>
              </div>
              <Field label={`Expected CTC (${j.currency}/yr)`} error={e.expected_ctc?.message} htmlFor="ec"><Input id="ec" type="number" min={0} {...form.register('expected_ctc')} /></Field>
              <Field label="LinkedIn profile" error={e.linkedin_url?.message} htmlFor="li"><Input id="li" type="url" placeholder="https://linkedin.com/in/…" {...form.register('linkedin_url')} /></Field>
              <Field label="Highest qualification" error={e.highest_qualification?.message} htmlFor="hq"><Input id="hq" placeholder="e.g. B.Tech Computer Science" {...form.register('highest_qualification')} /></Field>
              <div className="grid grid-cols-[1fr_7rem] gap-3">
                <Field label="Institution" error={e.institution?.message} htmlFor="in"><Input id="in" {...form.register('institution')} /></Field>
                <Field label="Year" error={e.graduation_year?.message} htmlFor="gy"><Input id="gy" inputMode="numeric" maxLength={4} placeholder="2022" {...form.register('graduation_year')} /></Field>
              </div>
              <Field label="Key skills" hint="Comma separated" htmlFor="sk"><Input id="sk" {...form.register('skills')} /></Field>
              <Field label="Resume" required error={fileError} hint="PDF or Word, max 5 MB">
                <label className={`flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed px-4 py-4 text-sm transition ${fileError ? 'border-rose-300 bg-rose-50' : file ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'}`}>
                  {file ? <FileUp className="h-5 w-5 text-emerald-600" /> : <Upload className="h-5 w-5 text-slate-400" />}
                  <span className="min-w-0 flex-1 truncate">{file ? `${file.name} (${fileSize(file.size)})` : 'Click to upload your resume'}</span>
                  <input type="file" className="sr-only" accept=".pdf,.doc,.docx" onChange={(ev) => pickFile(ev.target.files?.[0])} />
                </label>
              </Field>
              <Field label="Cover letter" error={e.cover_letter?.message} htmlFor="cv"><Textarea id="cv" rows={4} {...form.register('cover_letter')} /></Field>
              <input type="text" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden {...form.register('website')} />
              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input type="checkbox" className="mt-0.5 rounded border-slate-300" {...form.register('consent')} />
                <span>I consent to {c.name} processing my personal data for recruitment purposes.</span>
              </label>
              {e.consent && <p className="error-text">{e.consent.message}</p>}
              <Button type="submit" className="w-full" loading={form.formState.isSubmitting} style={{ background: c.primary_color }}>Submit application</Button>
            </form>
          </aside>
        </div>
      </div>
    </CareersShell>
  );
}
