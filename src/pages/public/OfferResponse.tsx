import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Building2, CheckCircle2, Download, FileSignature, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, ConfirmDialog, DescriptionList, Field, Input, PageLoader } from '@/components/ui';
import { api } from '@/lib/backend';
import { downloadBlob } from '@/lib/csv';
import { fmtDate, fmtDateTime, fmtMoney, titleCase } from '@/lib/format';
import { generateOfferPdf, type PdfCompany } from '@/lib/pdf';

interface PublicOffer {
  status: string; offer_number: string; candidate_name: string; job_title: string; designation: string | null; department: string | null;
  reporting_manager: string | null; employment_type: string; work_location: string | null; ctc_annual: number; basic_monthly: number;
  hra_monthly: number; allowances_monthly: number; joining_date: string; expiry_date: string; probation_months: number;
  additional_terms: string | null; created_at: string; responded_at: string | null; candidate_signature: string | null;
  company: PdfCompany & { logo_url: string | null };
}

export function OfferResponse() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['public-offer', token], queryFn: () => api.db.rpc<PublicOffer>('public_get_offer', { p_token: token }), retry: false });
  const [signature, setSignature] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [declineOpen, setDeclineOpen] = useState(false);

  if (q.isLoading) return <PageLoader label="Loading your offer…" />;
  if (q.isError || !q.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <div className="card max-w-md p-10 text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" />
          <h1 className="mt-4 text-lg font-semibold">This offer link is invalid or has expired</h1>
          <p className="mt-2 text-sm text-slate-500">For your security, offer links are personal and time-limited. Please contact the HR team who sent you the offer.</p>
        </div>
      </div>
    );
  }
  const o = q.data;
  const cur = o.company.currency || 'INR';
  const pdf = () => downloadBlob(`Offer-${o.offer_number}.pdf`, generateOfferPdf({ ...o, issued_at: o.created_at }));

  const respond = async (accept: boolean, reason?: string) => {
    setBusy(true);
    setError('');
    try {
      await api.db.rpc('public_respond_offer', { p_token: token, p_accept: accept, p_signature: accept ? signature : null, p_reason: reason ?? null });
      void api.processEmails();
      setDeclineOpen(false);
      await qc.invalidateQueries({ queryKey: ['public-offer', token] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const banner = {
    accepted: { icon: <CheckCircle2 className="h-6 w-6" />, cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', text: `You accepted this offer on ${fmtDateTime(o.responded_at)}. Welcome aboard! HR will contact you about onboarding.` },
    declined: { icon: <XCircle className="h-6 w-6" />, cls: 'bg-slate-50 text-slate-700 border-slate-200', text: `You declined this offer on ${fmtDateTime(o.responded_at)}.` },
    expired: { icon: <AlertTriangle className="h-6 w-6" />, cls: 'bg-amber-50 text-amber-800 border-amber-200', text: 'This offer has expired. Please contact HR if you are still interested.' },
    withdrawn: { icon: <AlertTriangle className="h-6 w-6" />, cls: 'bg-amber-50 text-amber-800 border-amber-200', text: 'This offer has been withdrawn by the company.' },
  }[o.status as 'accepted'];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="text-white" style={{ background: o.company.primary_color ?? '#2549eb' }}>
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-5">
          {o.company.logo_url ? <img src={o.company.logo_url} alt="" className="h-10 w-10 rounded-lg bg-white object-cover" /> : <Building2 className="h-8 w-8" />}
          <div>
            <p className="text-sm text-white/80">Offer of employment</p>
            <p className="text-lg font-semibold">{o.company.name}</p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-5 px-6 py-8">
        {banner && <div className={`flex items-start gap-3 rounded-xl border px-5 py-4 text-sm ${banner.cls}`}>{banner.icon}<p className="pt-0.5">{banner.text}</p></div>}
        <div className="card p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">Congratulations, {o.candidate_name}!</h1>
              <p className="mt-1 text-slate-600">We are pleased to offer you the role of <strong>{o.designation || o.job_title}</strong>.</p>
            </div>
            <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={pdf}>Offer letter (PDF)</Button>
          </div>
          <div className="my-6 rounded-xl bg-slate-50 p-5 text-center">
            <p className="text-sm text-slate-500">Annual cost to company</p>
            <p className="mt-1 text-3xl font-bold text-slate-900">{fmtMoney(o.ctc_annual, cur)}</p>
          </div>
          <DescriptionList items={[
            { label: 'Offer reference', value: o.offer_number },
            { label: 'Department', value: o.department },
            { label: 'Employment type', value: titleCase(o.employment_type) },
            { label: 'Work location', value: o.work_location },
            { label: 'Reporting manager', value: o.reporting_manager },
            { label: 'Joining date', value: fmtDate(o.joining_date) },
            { label: 'Probation', value: o.probation_months ? `${o.probation_months} months` : 'None' },
            { label: 'Respond by', value: fmtDate(o.expiry_date) },
            { label: 'Monthly basic', value: fmtMoney(o.basic_monthly, cur) },
            { label: 'Monthly HRA', value: fmtMoney(o.hra_monthly, cur) },
            { label: 'Monthly allowances', value: fmtMoney(o.allowances_monthly, cur) },
          ]} />
          {o.additional_terms && <div className="mt-6 rounded-lg border border-slate-200 p-4 text-sm text-slate-700"><p className="mb-1 font-medium">Additional terms</p>{o.additional_terms}</div>}
        </div>

        {o.status === 'sent' && (
          <div className="card p-6 sm:p-8">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><FileSignature className="h-5 w-5 text-brand-600" /> Accept your offer</h2>
            <p className="mt-1 text-sm text-slate-500">Sign electronically by typing your full name exactly as shown: <strong>{o.candidate_name}</strong></p>
            {error && <div role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>}
            <Field label="Full name (e-signature)" className="mt-4" htmlFor="sig">
              <Input id="sig" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={o.candidate_name} className="font-serif text-lg italic" autoComplete="name" />
            </Field>
            <label className="mt-4 flex items-start gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 rounded border-slate-300" />
              I have read the offer letter and accept the terms of employment.
            </label>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={() => setDeclineOpen(true)} disabled={busy}>Decline offer</Button>
              <Button variant="success" loading={busy} disabled={!agree || signature.trim().length < 3} onClick={() => respond(true)}>Accept offer</Button>
            </div>
          </div>
        )}
        <p className="text-center text-xs text-slate-400">This secure link is personal to you. Do not share it.</p>
      </main>
      <ConfirmDialog open={declineOpen} onClose={() => setDeclineOpen(false)} title="Decline this offer?" tone="danger" confirmLabel="Decline offer" loading={busy}
        message="We're sorry to see you go. This cannot be undone." input={{ label: 'Reason (optional, helps us improve)', multiline: true }}
        onConfirm={(reason) => respond(false, reason)} />
    </div>
  );
}
