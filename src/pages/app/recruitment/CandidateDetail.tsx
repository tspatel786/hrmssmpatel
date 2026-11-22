import { ArrowLeft, CalendarPlus, Download, Eye, FileSignature, FileText, Linkedin, Mail, MapPin, MessageSquare, Pencil, Phone, Star, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { StatusBadge } from '@/components/DataTable';
import { clean, FormModal, type FieldDef } from '@/components/FormModal';
import { Avatar, Badge, Button, Card, ConfirmDialog, DescriptionList, EmptyState, ErrorState, PageLoader, Select, Tabs, Textarea } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { DOC_TYPES, RESUME_MIME, SOURCES, stageInfo } from '@/lib/constants';
import { downloadBlob } from '@/lib/csv';
import { fileSize, fmtDate, fmtDateTime, fmtMoney, fmtRelative, titleCase } from '@/lib/format';
import { useAction, useList } from '@/lib/hooks';
import { optNum, optStr, optUrl, reqStr, tags } from '@/lib/schemas';
import { OfferFormModal } from '../offers/OfferForm';
import { FeedbackModal, ScheduleInterviewModal, StageDialog } from './actions';
import type { Application, Candidate } from './Candidates';

interface Doc { id: string; doc_type: string; file_name: string; storage_bucket: string; storage_path: string; mime_type: string | null; size_bytes: number | null; created_at: string; application_id: string | null }
interface Note { id: string; body: string; created_by: string; created_at: string }
interface History { id: string; application_id: string; from_stage: string | null; to_stage: string; note: string | null; created_at: string }
interface Iv { id: string; application_id: string; round_name: string; interview_type: string; scheduled_at: string; duration_minutes: number; status: string; meeting_link: string | null; location: string | null; notes: string | null; panelists: { id: string; name: string }[]; panelist_ids: string[] | null; job_title: string; feedback_count: number }
interface Fb { id: string; interview_id: string; interviewer_id: string; interviewer_name: string; round_name: string; overall_rating: number; technical_rating: number | null; communication_rating: number | null; culture_rating: number | null; recommendation: string; strengths: string | null; weaknesses: string | null; comments: string | null; submitted_at: string }
interface OfferRow { id: string; application_id: string; status: string; offer_number: string; ctc_annual: number }

const editSchema = z.object({
  first_name: reqStr(1, 60, 'First name'), last_name: optStr(60), email: z.string().trim().email('Enter a valid email'),
  phone: optStr(20), current_title: optStr(100), current_company: optStr(100), current_location: optStr(80),
  experience_years: optNum(60), current_ctc: optNum(), expected_ctc: optNum(), notice_period_days: optNum(365),
  linkedin_url: optUrl, portfolio_url: optUrl, source: z.string(), skills: tags, tags: tags,
});
type EditValues = z.infer<typeof editSchema>;

async function openDoc(d: Doc, download = false) {
  try {
    if (download) {
      downloadBlob(d.file_name, await api.storage.download(d.storage_bucket, d.storage_path));
    } else {
      const url = await api.storage.signedUrl(d.storage_bucket, d.storage_path, 300);
      window.open(url, '_blank', 'noopener');
    }
  } catch (e) {
    toast.error((e as Error).message);
  }
}

export function CandidateDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { companyId, company, can } = useCompany();
  const { user } = useSession();
  const cand = useList<Candidate>({ table: 'v_candidates', filters: [{ column: 'id', op: 'eq', value: id }], count: false });
  const apps = useList<Application>({ table: 'v_applications', filters: [{ column: 'candidate_id', op: 'eq', value: id }], order: [{ column: 'applied_at', ascending: false }] });
  const appIds = (apps.data?.rows ?? []).map((a) => a.id);
  const docs = useList<Doc>({ table: 'candidate_documents', filters: [{ column: 'candidate_id', op: 'eq', value: id }], order: [{ column: 'created_at', ascending: false }] });
  const notes = useList<Note>(can('candidates.view') ? { table: 'candidate_notes', filters: [{ column: 'candidate_id', op: 'eq', value: id }], order: [{ column: 'created_at', ascending: false }] } : null);
  const history = useList<History>(appIds.length ? { table: 'application_stage_history', filters: [{ column: 'application_id', op: 'in', value: appIds }], order: [{ column: 'created_at', ascending: false }] } : null);
  const ivs = useList<Iv>({ table: 'v_interviews', filters: [{ column: 'candidate_id', op: 'eq', value: id }], order: [{ column: 'scheduled_at', ascending: false }] });
  const ivIds = (ivs.data?.rows ?? []).map((i) => i.id);
  const fb = useList<Fb>(ivIds.length ? { table: 'v_feedback', filters: [{ column: 'interview_id', op: 'in', value: ivIds }], order: [{ column: 'submitted_at', ascending: false }] } : null);
  const offers = useList<OfferRow>(can(['offers.view', 'offers.approve']) && appIds.length ? { table: 'offers', columns: 'id,application_id,status,offer_number,ctc_annual', filters: [{ column: 'application_id', op: 'in', value: appIds }] } : null);

  const [tab, setTab] = useState<'overview' | 'interviews' | 'documents' | 'activity'>('overview');
  const [stageFor, setStageFor] = useState<Application | null>(null);
  const [scheduleFor, setScheduleFor] = useState<Application | null>(null);
  const [offerFor, setOfferFor] = useState<Application | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<Iv | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [docType, setDocType] = useState('resume');
  const fileRef = useRef<HTMLInputElement>(null);

  const addNote = useAction(() => api.db.insert('candidate_notes', { company_id: companyId, candidate_id: id, body: noteText.trim(), created_by: user?.id }), { success: 'Note added', onSuccess: () => setNoteText('') });
  const delNote = useAction((nid: string) => api.db.remove('candidate_notes', nid), { success: 'Note deleted' });
  const save = useAction((v: EditValues) => api.db.update('candidates', id, clean({ ...v, email: v.email.toLowerCase(), skills: v.skills.filter(Boolean), tags: v.tags.filter(Boolean) } as Record<string, unknown>)), { success: 'Candidate updated' });
  const remove = useAction(() => api.db.remove('candidates', id), { success: 'Candidate deleted', onSuccess: () => navigate('/app/recruitment/candidates') });
  const rate = useAction(({ appId, rating }: { appId: string; rating: number }) => api.db.update('applications', appId, { rating }), { success: 'Rating saved' });
  const upload = useAction(async (f: File) => {
    if (!RESUME_MIME.includes(f.type) && !['image/png', 'image/jpeg'].includes(f.type)) throw new Error('Upload a PDF, Word document or image');
    if (f.size > 5242880) throw new Error('File must be 5 MB or smaller');
    const path = `${companyId}/candidates/${id}/${Date.now()}-${f.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    const bucket = RESUME_MIME.includes(f.type) ? 'resumes' : 'documents';
    await api.storage.upload(bucket, path, f, f.type);
    await api.db.insert('candidate_documents', { company_id: companyId, candidate_id: id, application_id: apps.data?.rows[0]?.id ?? null, doc_type: docType, file_name: f.name, storage_bucket: bucket, storage_path: path, mime_type: f.type, size_bytes: f.size });
  }, { success: 'Document uploaded' });
  const delDoc = useAction(async (d: Doc) => {
    await api.db.remove('candidate_documents', d.id);
    await api.storage.remove(d.storage_bucket, d.storage_path).catch(() => undefined);
  }, { success: 'Document deleted' });

  if (cand.isLoading) return <PageLoader />;
  if (cand.isError) return <ErrorState error={cand.error} onRetry={() => cand.refetch()} />;
  const c = cand.data?.rows[0];
  if (!c) return <ErrorState error="Candidate not found or you do not have access." />;
  const manage = can('candidates.manage');
  const myFeedback = (ivId: string) => (fb.data?.rows ?? []).find((f) => f.interview_id === ivId && f.interviewer_id === user?.id);
  const offerFor_ = (appId: string) => (offers.data?.rows ?? []).filter((o) => o.application_id === appId);

  const fields: FieldDef<EditValues>[] = [
    { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name' },
    { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'current_title', label: 'Current title' }, { name: 'current_company', label: 'Current company' },
    { name: 'current_location', label: 'Location' }, { name: 'experience_years', label: 'Experience (years)', type: 'number', step: '0.5' },
    { name: 'current_ctc', label: 'Current CTC', type: 'number' }, { name: 'expected_ctc', label: 'Expected CTC', type: 'number' },
    { name: 'notice_period_days', label: 'Notice period (days)', type: 'number' }, { name: 'source', label: 'Source', type: 'select', options: SOURCES, required: true },
    { name: 'linkedin_url', label: 'LinkedIn URL', type: 'url' }, { name: 'portfolio_url', label: 'Portfolio URL', type: 'url' },
    { name: 'skills', label: 'Skills', type: 'tags', span: 2 }, { name: 'tags', label: 'Tags', type: 'tags', span: 2, hint: 'e.g. top-talent, relocate' },
  ];

  return (
    <>
      <Link to={can('candidates.view') ? '/app/recruitment/candidates' : '/app/recruitment/interviews'} className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Back</Link>
      <div className="card mb-5 p-6">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-4">
            <Avatar name={c.full_name} size="lg" />
            <div>
              <h1 className="text-2xl font-semibold">{c.full_name}</h1>
              <p className="text-slate-600">{c.current_title ?? 'Candidate'}{c.current_company && ` at ${c.current_company}`}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
                <a href={`mailto:${c.email}`} className="flex items-center gap-1 hover:text-brand-700"><Mail className="h-4 w-4" />{c.email}</a>
                {c.phone && <a href={`tel:${c.phone}`} className="flex items-center gap-1 hover:text-brand-700"><Phone className="h-4 w-4" />{c.phone}</a>}
                {c.current_location && <span className="flex items-center gap-1"><MapPin className="h-4 w-4" />{c.current_location}</span>}
                {c.linkedin_url && <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-brand-700"><Linkedin className="h-4 w-4" />LinkedIn</a>}
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{c.skills.map((s) => <Badge key={s} tone="blue">{s}</Badge>)}{c.tags.map((t) => <Badge key={t} tone="violet">#{t}</Badge>)}</div>
            </div>
          </div>
          {manage && (
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>
              {!(apps.data?.rows ?? []).some((a) => ['offered', 'hired'].includes(a.stage)) && <Button variant="ghost" aria-label="Delete candidate" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card title="Applications" padded={false}>
            {apps.isLoading ? <PageLoader /> : (apps.data?.rows ?? []).length === 0 ? <EmptyState title="No applications" description="This candidate has not applied to any job yet." /> : (
              <ul className="divide-y divide-slate-100">
                {apps.data!.rows.map((a) => {
                  const st = stageInfo(a.stage);
                  const appOffers = offerFor_(a.id);
                  return (
                    <li key={a.id} className="p-5">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <Link to={`/app/recruitment/jobs/${a.job_id}`} className="font-semibold text-slate-900 hover:underline">{a.job_title}</Link>
                          <span className="ml-2 font-mono text-[11px] text-slate-400" title="Application reference">{`APP-${a.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`}</span>
                          <p className="text-xs text-slate-500">Applied {fmtRelative(a.applied_at)} via {titleCase(a.source)} · {a.department_name ?? '—'}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Badge tone={st.tone} dot>{st.label}</Badge>
                            {a.avg_feedback_rating && <Badge tone="yellow">★ {a.avg_feedback_rating} interview avg</Badge>}
                            {appOffers.map((o) => <Link key={o.id} to={`/app/offers/${o.id}`}><StatusBadge kind="offer" value={o.status} /></Link>)}
                          </div>
                          {a.rejection_reason && <p className="mt-2 text-xs text-rose-600">Reason: {a.rejection_reason}</p>}
                        </div>
                        {manage && (
                          <div className="flex flex-wrap gap-2">
                            {!['hired', 'offered', 'withdrawn'].includes(a.stage) && <Button size="sm" variant="secondary" onClick={() => setStageFor(a)}>Change stage</Button>}
                            {can('interviews.manage') && !['rejected', 'withdrawn', 'hired', 'offered'].includes(a.stage) && <Button size="sm" variant="secondary" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setScheduleFor(a)}>Interview</Button>}
                            {can('offers.manage') && a.stage === 'selected' && !appOffers.some((o) => ['draft', 'pending_approval', 'approved', 'sent', 'accepted'].includes(o.status)) && (
                              <Button size="sm" icon={<FileSignature className="h-4 w-4" />} onClick={() => setOfferFor(a)}>Create offer</Button>
                            )}
                          </div>
                        )}
                      </div>
                      {manage && (
                        <div className="mt-3 flex items-center gap-1 text-xs text-slate-500">
                          Recruiter rating:
                          {[1, 2, 3, 4, 5].map((n) => (
                            <button key={n} type="button" aria-label={`Rate ${n}`} onClick={() => rate.mutate({ appId: a.id, rating: n })}>
                              <Star className={`h-4 w-4 ${n <= (a.rating ?? 0) ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />
                            </button>
                          ))}
                        </div>
                      )}
                      {a.cover_letter && <details className="mt-3 text-sm"><summary className="cursor-pointer text-slate-500">Cover letter</summary><p className="mt-2 whitespace-pre-line text-slate-700">{a.cover_letter}</p></details>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div>
            <Tabs value={tab} onChange={setTab} tabs={[
              { value: 'overview', label: 'Feedback', count: fb.data?.rows.length ?? 0 },
              { value: 'interviews', label: 'Interviews', count: ivs.data?.rows.length ?? 0 },
              { value: 'documents', label: 'Documents', count: docs.data?.rows.length ?? 0 },
              { value: 'activity', label: 'Stage history' },
            ]} />
            <div className="card mt-4 overflow-hidden">
              {tab === 'overview' && ((fb.data?.rows ?? []).length === 0 ? <EmptyState title="No feedback yet" description="Feedback appears here once interviewers submit it." /> : (
                <ul className="divide-y divide-slate-100">
                  {fb.data!.rows.map((f) => (
                    <li key={f.id} className="p-5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{f.interviewer_name} <span className="text-sm font-normal text-slate-500">· {f.round_name}</span></p>
                        <div className="flex items-center gap-2"><span className="text-sm font-semibold text-amber-600">★ {f.overall_rating}/5</span><StatusBadge kind="recommendation" value={f.recommendation} /></div>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">Technical {f.technical_rating ?? '—'} · Communication {f.communication_rating ?? '—'} · Culture {f.culture_rating ?? '—'} · {fmtRelative(f.submitted_at)}</p>
                      {f.strengths && <p className="mt-2 text-sm"><span className="font-medium text-emerald-700">Strengths: </span>{f.strengths}</p>}
                      {f.weaknesses && <p className="mt-1 text-sm"><span className="font-medium text-rose-700">Concerns: </span>{f.weaknesses}</p>}
                      {f.comments && <p className="mt-1 text-sm text-slate-600">{f.comments}</p>}
                    </li>
                  ))}
                </ul>
              ))}
              {tab === 'interviews' && ((ivs.data?.rows ?? []).length === 0 ? <EmptyState title="No interviews scheduled" /> : (
                <ul className="divide-y divide-slate-100">
                  {ivs.data!.rows.map((i) => {
                    const isPanel = (i.panelist_ids ?? []).includes(user?.id ?? '');
                    const started = new Date(i.scheduled_at).getTime() <= Date.now() + 15 * 60000;
                    return (
                      <li key={i.id} className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="font-medium">{i.round_name} <span className="text-sm font-normal text-slate-500">· {i.job_title} · {titleCase(i.interview_type)}</span></p>
                          <p className="text-sm text-slate-500">{fmtDateTime(i.scheduled_at)} · {i.duration_minutes} min · {i.panelists.map((p) => p.name).join(', ')}</p>
                          {i.meeting_link && <a href={i.meeting_link} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">{i.meeting_link}</a>}
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge kind="interview" value={i.status} />
                          {(isPanel || can('interviews.manage')) && i.status !== 'cancelled' && started && (
                            <Button size="sm" variant="secondary" icon={<MessageSquare className="h-4 w-4" />} onClick={() => setFeedbackFor(i)}>{myFeedback(i.id) ? 'Edit feedback' : 'Add feedback'}</Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ))}
              {tab === 'documents' && (
                <div>
                  {manage && (
                    <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
                      <Select className="w-auto h-9" value={docType} onChange={(e) => setDocType(e.target.value)} options={DOC_TYPES} aria-label="Document type" />
                      <Button size="sm" variant="secondary" icon={<Upload className="h-4 w-4" />} loading={upload.isPending} onClick={() => fileRef.current?.click()}>Upload document</Button>
                      <input ref={fileRef} type="file" className="hidden" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
                    </div>
                  )}
                  {(docs.data?.rows ?? []).length === 0 ? <EmptyState icon={<FileText className="h-6 w-6" />} title="No documents" /> : (
                    <ul className="divide-y divide-slate-100">
                      {docs.data!.rows.map((d) => (
                        <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                          <FileText className="h-8 w-8 shrink-0 rounded-lg bg-brand-50 p-1.5 text-brand-600" />
                          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{d.file_name}</p><p className="text-xs text-slate-500">{titleCase(d.doc_type)} · {fileSize(d.size_bytes)} · {fmtDate(d.created_at)}</p></div>
                          <Button size="sm" variant="ghost" aria-label="View" onClick={() => openDoc(d)}><Eye className="h-4 w-4" /></Button>
                          <Button size="sm" variant="ghost" aria-label="Download" onClick={() => openDoc(d, true)}><Download className="h-4 w-4" /></Button>
                          {manage && <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => delDoc.mutate(d)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {tab === 'activity' && ((history.data?.rows ?? []).length === 0 ? <EmptyState title="No history" /> : (
                <ol className="relative space-y-5 p-6 before:absolute before:bottom-6 before:left-[29px] before:top-6 before:w-px before:bg-slate-200">
                  {history.data!.rows.map((h) => {
                    const app = apps.data?.rows.find((a) => a.id === h.application_id);
                    return (
                      <li key={h.id} className="relative flex gap-4">
                        <span className="z-10 mt-1 h-3 w-3 shrink-0 rounded-full ring-4 ring-white" style={{ background: stageInfo(h.to_stage).color }} />
                        <div className="text-sm">
                          <p><span className="font-medium">{h.from_stage ? `${stageInfo(h.from_stage).label} → ` : ''}{stageInfo(h.to_stage).label}</span> <span className="text-slate-500">· {app?.job_title}</span></p>
                          {h.note && <p className="text-slate-600">{h.note}</p>}
                          <p className="text-xs text-slate-400">{fmtDateTime(h.created_at)}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <Card title="Profile">
            <DescriptionList cols={1} items={[
              { label: 'Experience', value: c.experience_years != null ? `${c.experience_years} years` : '—' },
              { label: 'Education', value: c.highest_qualification ? `${c.highest_qualification}${c.institution ? `, ${c.institution}` : ''}${c.graduation_year ? ` (${c.graduation_year})` : ''}` : '—' },
              { label: 'Current CTC', value: fmtMoney(c.current_ctc, company?.currency) },
              { label: 'Expected CTC', value: fmtMoney(c.expected_ctc, company?.currency) },
              { label: 'Notice period', value: c.notice_period_days != null ? `${c.notice_period_days} days` : '—' },
              { label: 'Source', value: titleCase(c.source) },
              { label: 'In talent pool since', value: fmtDate(c.created_at) },
            ]} />
          </Card>
          {can('candidates.view') && (
            <Card title="Notes">
              <div className="space-y-2">
                <Textarea rows={3} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a private note for the hiring team…" maxLength={4000} />
                <Button size="sm" disabled={noteText.trim().length < 1} loading={addNote.isPending} onClick={() => addNote.mutate()}>Add note</Button>
              </div>
              <ul className="mt-4 space-y-3">
                {(notes.data?.rows ?? []).map((n) => (
                  <li key={n.id} className="rounded-lg bg-slate-50 p-3 text-sm">
                    <p className="whitespace-pre-line text-slate-700">{n.body}</p>
                    <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                      <span>{fmtRelative(n.created_at)}</span>
                      {(n.created_by === user?.id || manage) && <button type="button" className="hover:text-rose-600" onClick={() => delNote.mutate(n.id)}>Delete</button>}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {stageFor && <StageDialog open onClose={() => setStageFor(null)} applicationId={stageFor.id} current={stageFor.stage} candidateName={`${c.full_name} · ${stageFor.job_title}`} />}
      {scheduleFor && <ScheduleInterviewModal open onClose={() => setScheduleFor(null)} applicationId={scheduleFor.id} candidateName={`${c.full_name} · ${scheduleFor.job_title}`} />}
      {offerFor && <OfferFormModal open onClose={() => setOfferFor(null)} application={offerFor} onSaved={(oid) => navigate(`/app/offers/${oid}`)} />}
      {feedbackFor && <FeedbackModal open onClose={() => setFeedbackFor(null)} interviewId={feedbackFor.id} title={`${c.full_name} · ${feedbackFor.round_name}`} existing={myFeedback(feedbackFor.id)} />}
      {editing && <FormModal open onClose={() => setEditing(false)} title="Edit candidate" size="xl" schema={editSchema} fields={fields} defaultValues={c as never} onSubmit={(v) => save.mutateAsync(v)} />}
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} title="Delete candidate?" tone="danger" confirmLabel="Delete permanently" loading={remove.isPending}
        message="All applications, interviews, notes and documents for this candidate will be deleted. This cannot be undone." onConfirm={() => remove.mutate()} />
    </>
  );
}
