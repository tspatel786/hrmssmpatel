// /joining-documents/:token — a new joiner uploads the documents HR asked for (no account needed; migration 1900).
import { CheckCircle2, Clock, FileUp, ShieldCheck, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Logo } from '@/components/Logo';
import { Badge, PageLoader } from '@/components/ui';
import { api } from '@/lib/backend';
import { fmtDate } from '@/lib/format';

interface Doc { id: string; label: string; required: boolean; status: 'pending' | 'submitted' | 'verified' | 'rejected'; file_name: string | null; note: string | null }
interface Portal { onboarding_id: string; company_id: string; company_name: string; company_logo: string | null; candidate_name: string; job_title: string; joining_date: string; open: boolean; documents: Doc[] }

const ACCEPT = 'application/pdf,image/png,image/jpeg';
const MAX = 10 * 1024 * 1024;

const STATUS: Record<Doc['status'], { tone: 'gray' | 'blue' | 'green' | 'red'; label: string; icon: JSX.Element }> = {
  pending: { tone: 'gray', label: 'Not uploaded', icon: <Clock className="h-3.5 w-3.5" /> },
  submitted: { tone: 'blue', label: 'Uploaded · awaiting check', icon: <Clock className="h-3.5 w-3.5" /> },
  verified: { tone: 'green', label: 'Verified', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  rejected: { tone: 'red', label: 'Please upload again', icon: <XCircle className="h-3.5 w-3.5" /> },
};

export function JoiningDocuments() {
  const { token = '' } = useParams();
  const [p, setP] = useState<Portal | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.db.rpc<Portal>('public_onboarding_documents', { p_token: token }).then(setP).catch((e: Error) => setError(e.message));
  }, [token]);
  useEffect(load, [load]);

  const upload = async (d: Doc, file: File) => {
    if (!p) return;
    if (file.size > MAX) { toast.error('File must be 10 MB or smaller'); return; }
    if (!ACCEPT.split(',').includes(file.type)) { toast.error('Upload a PDF, JPG or PNG file'); return; }
    setBusy(d.id);
    try {
      const safe = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
      const path = `${p.company_id}/onboarding/${p.onboarding_id}/${crypto.randomUUID()}/${safe}`;
      await api.storage.upload('documents', path, file, file.type);
      await api.db.rpc('public_submit_onboarding_document', { p_token: token, p_document: d.id, p_file: { path, name: file.name, size: file.size, mime: file.type } });
      void api.processEmails();
      toast.success(`${d.label} uploaded`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="card max-w-md p-8 text-center"><p className="font-semibold text-slate-900">This link is not valid</p><p className="mt-2 text-sm text-slate-500">Open the latest email from HR, or ask them to send the link again.</p></div>
      </div>
    );
  }
  if (!p) return <PageLoader />;
  const required = p.documents.filter((d) => d.required);
  const done = required.filter((d) => d.status === 'verified' || d.status === 'submitted').length;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-brand-500/15 bg-ink text-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4 sm:px-6">
          {p.company_logo ? <img src={p.company_logo} alt="" className="h-10 w-10 rounded-lg bg-white object-contain" /> : <Logo size={40} showName={false} />}
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-brand-400">Joining documents</p>
            <p className="truncate font-display text-lg font-semibold">{p.company_name}</p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-6">
        <div className="card p-6">
          <h1 className="text-xl font-semibold text-slate-900">Hi {p.candidate_name.split(' ')[0]}, welcome!</h1>
          <p className="mt-1 text-sm text-slate-600">
            Upload these documents for your joining as <strong>{p.job_title}</strong> on <strong>{fmtDate(p.joining_date)}</strong>. PDF, JPG or PNG, up to 10 MB each.
          </p>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
            <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${required.length ? (done / required.length) * 100 : 100}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-slate-500" data-testid="docs-progress">{done} of {required.length} required documents uploaded</p>
          {!p.open && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Document upload is closed for this joining.</p>}
        </div>

        <ul className="space-y-3" data-testid="joining-docs">
          {p.documents.map((d) => {
            const st = STATUS[d.status];
            const canUpload = p.open && d.status !== 'verified';
            return (
              <li key={d.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{d.label}{!d.required && <span className="ml-1.5 text-xs font-normal text-slate-500">(optional)</span>}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone={st.tone}>{st.icon} {st.label}</Badge>
                    {d.file_name && <span className="truncate text-slate-500">{d.file_name}</span>}
                  </div>
                  {d.status === 'rejected' && d.note && <p className="mt-1.5 text-sm text-rose-700">HR: {d.note}</p>}
                </div>
                {canUpload && (
                  <label className={`btn-secondary cursor-pointer ${busy === d.id ? 'pointer-events-none opacity-60' : ''}`}>
                    <FileUp className="h-4 w-4" /> {busy === d.id ? 'Uploading…' : d.status === 'pending' ? 'Upload' : 'Replace'}
                    <input type="file" className="sr-only" accept={ACCEPT} aria-label={`Upload ${d.label}`}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(d, f); e.target.value = ''; }} />
                  </label>
                )}
              </li>
            );
          })}
        </ul>
        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-slate-500"><ShieldCheck className="h-4 w-4" /> Your documents are visible only to the HR team of {p.company_name}.</p>
      </main>
    </div>
  );
}
