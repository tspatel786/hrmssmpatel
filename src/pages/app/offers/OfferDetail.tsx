import { ArrowLeft, CheckCircle2, Copy, Download, Eye, Pencil, Send, Trash2, Undo2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/DataTable';
import { Button, Card, ConfirmDialog, DescriptionList, ErrorState, Modal, PageHeader, PageLoader } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { appBaseUrl, config } from '@/lib/config';
import { downloadBlob } from '@/lib/csv';
import { fmtDate, fmtDateTime, fmtMoney, titleCase } from '@/lib/format';
import { useAction, useList } from '@/lib/hooks';
import { pdfCompany } from '@/lib/letters';
import { generateOfferPdf, type PdfCompany } from '@/lib/pdf';
import { OfferFormModal, type Offer } from './OfferForm';
import { useOfferTemplates } from './OfferTemplates';

interface Approval { id: string; action: string; comments: string | null; actor_id: string | null; created_at: string }

export function OfferDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { companyId, company, can } = useCompany();
  const q = useList<Offer>({ table: 'v_offers', filters: [{ column: 'id', op: 'eq', value: id }], count: false });
  const history = useList<Approval>({ table: 'offer_approvals', filters: [{ column: 'offer_id', op: 'eq', value: id }], order: [{ column: 'created_at', ascending: false }] });
  const members = useList<{ user_id: string; full_name: string | null; email: string }>(companyId ? { table: 'v_members', columns: 'user_id,full_name,email', filters: [{ column: 'company_id', op: 'eq', value: companyId }], range: [0, 999], count: false } : null);
  const templates = useOfferTemplates(false);
  const [editing, setEditing] = useState(false);
  const [deciding, setDeciding] = useState<boolean | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sentLink, setSentLink] = useState<string | null>(null);

  const o = q.data?.rows[0];
  // company letterhead (loaded once) so previews and downloads look like the letter that is emailed
  const [letterCo, setLetterCo] = useState<PdfCompany | null>(null);
  useEffect(() => { if (company) void pdfCompany(company).then(setLetterCo); }, [company]);
  const pdfData = () => ({
    offer_number: o!.offer_number, candidate_name: o!.candidate_name, job_title: o!.job_title, designation: o!.designation_title, department: o!.department_name,
    reporting_manager: o!.reporting_manager_name, employment_type: o!.employment_type, work_location: o!.work_location, ctc_annual: o!.ctc_annual,
    basic_monthly: o!.basic_monthly, hra_monthly: o!.hra_monthly, allowances_monthly: o!.allowances_monthly, joining_date: o!.joining_date,
    expiry_date: o!.expiry_date, probation_months: o!.probation_months, additional_terms: o!.additional_terms, issued_at: o!.sent_at ?? new Date().toISOString(),
    candidate_signature: o!.candidate_signature, responded_at: o!.responded_at, company: letterCo ?? company!,
    template: (() => { const tl = templates.data?.rows ?? []; return tl.find((t) => t.id === o!.template_id) ?? tl.find((t) => t.is_default) ?? null; })(),
  });

  const submit = useAction(() => api.db.rpc<string>('submit_offer_for_approval', { p_offer: id }), { success: (s) => (s === 'approved' ? 'Offer approved (approval not required)' : 'Submitted for approval') });
  const decide = useAction(({ approve, comments }: { approve: boolean; comments: string }) => api.db.rpc('decide_offer', { p_offer: id, p_approve: approve, p_comments: comments || null }), {
    success: 'Decision recorded', onSuccess: () => setDeciding(null),
  });
  const send = useAction(async () => {
    const pdf = generateOfferPdf({ ...pdfData(), company: await pdfCompany(company!) });
    const path = `${companyId}/offers/${id}.pdf`;
    await api.storage.upload('documents', path, pdf, 'application/pdf');
    return api.db.rpc<{ offer_link: string }>('send_offer', { p_offer: id, p_base_url: appBaseUrl(), p_pdf_path: path });
  }, { success: 'Offer sent · email with PDF queued', onSuccess: (r) => setSentLink(r.offer_link) });
  const withdraw = useAction((reason: string) => api.db.rpc('withdraw_offer', { p_offer: id, p_reason: reason }), { success: 'Offer withdrawn', onSuccess: () => setWithdrawing(false) });
  const remove = useAction(() => api.db.remove('offers', id), { success: 'Offer deleted', onSuccess: () => navigate('/app/offers') });

  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!o) return <ErrorState error="Offer not found or you do not have access." />;
  const cur = company?.currency;
  const manage = can('offers.manage');
  const nameOf = (uid: string | null) => (uid ? members.data?.rows.find((m) => m.user_id === uid)?.full_name ?? 'Team member' : 'Candidate');
  const preview = async () => window.open(URL.createObjectURL(o.status === 'sent' || o.status === 'accepted' ? await api.storage.download('documents', o.pdf_path!).catch(() => generateOfferPdf(pdfData())) : generateOfferPdf(pdfData())), '_blank', 'noopener');

  return (
    <>
      <PageHeader breadcrumb={<Link to="/app/offers" className="inline-flex items-center gap-1 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Offers</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{o.candidate_name} <StatusBadge kind="offer" value={o.status} /></span>}
        description={`${o.offer_number} · ${o.designation_title ?? o.job_title} · ${fmtMoney(o.ctc_annual, cur)} / year`}
        actions={
          <>
            <Button variant="secondary" icon={<Eye className="h-4 w-4" />} onClick={preview}>Preview PDF</Button>
            <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => downloadBlob(`Offer-${o.offer_number}.pdf`, generateOfferPdf(pdfData()))}>Download</Button>
            {manage && ['draft', 'rejected'].includes(o.status) && <>
              <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>
              <Button icon={<Send className="h-4 w-4" />} loading={submit.isPending} onClick={() => submit.mutate()}>{company?.offer_approval_required ? 'Submit for approval' : 'Approve'}</Button>
            </>}
            {can('offers.approve') && o.status === 'pending_approval' && <>
              <Button variant="danger" icon={<XCircle className="h-4 w-4" />} onClick={() => setDeciding(false)}>Reject</Button>
              <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setDeciding(true)}>Approve</Button>
            </>}
            {manage && ['approved', 'sent'].includes(o.status) && (
              <Button icon={<Send className="h-4 w-4" />} loading={send.isPending} onClick={() => send.mutate()}>{o.status === 'sent' ? 'Resend (new link)' : 'Send offer'}</Button>
            )}
            {manage && ['pending_approval', 'approved', 'sent'].includes(o.status) && <Button variant="ghost" icon={<Undo2 className="h-4 w-4" />} onClick={() => setWithdrawing(true)}>Withdraw</Button>}
            {manage && ['draft', 'rejected'].includes(o.status) && <Button variant="ghost" aria-label="Delete offer" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>}
          </>
        } />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {o.status === 'accepted' && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              Accepted by <strong>{o.candidate_signature}</strong> on {fmtDateTime(o.responded_at)}. {can('onboarding.view') && <Link to="/app/onboarding" className="font-semibold underline">Go to onboarding →</Link>}
            </div>
          )}
          {o.status === 'declined' && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Declined on {fmtDateTime(o.responded_at)}{o.decline_reason && <> — “{o.decline_reason}”</>}</div>}
          {o.status === 'sent' && (
            <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-800">
              Sent {fmtDateTime(o.sent_at)} · {o.viewed_at ? `Viewed by candidate ${fmtDateTime(o.viewed_at)}` : 'Not yet viewed'} · Link expires {fmtDateTime(o.token_expires_at)}
            </div>
          )}
          <Card title="Offer terms">
            <DescriptionList items={[
              { label: 'Candidate', value: <Link className="text-brand-700 hover:underline" to={`/app/recruitment/candidates/${o.candidate_id}`}>{o.candidate_name}</Link> },
              { label: 'Email', value: o.candidate_email },
              { label: 'Job', value: o.job_title },
              { label: 'Designation', value: o.designation_title },
              { label: 'Department', value: o.department_name },
              { label: 'Reporting manager', value: o.reporting_manager_name },
              { label: 'Employment type', value: titleCase(o.employment_type) },
              { label: 'Work location', value: o.work_location },
              { label: 'Joining date', value: fmtDate(o.joining_date) },
              { label: 'Offer valid until', value: fmtDate(o.expiry_date) },
              { label: 'Probation', value: `${o.probation_months} months` },
            ]} />
          </Card>
          <Card title="Compensation">
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Component</th><th className="text-right">Monthly</th><th className="text-right">Annual</th></tr></thead>
                <tbody>
                  {[['Basic', o.basic_monthly], ['HRA', o.hra_monthly], ['Allowances', o.allowances_monthly]].map(([l, v]) => (
                    <tr key={l as string}><td>{l}</td><td className="text-right">{fmtMoney(v as number, cur)}</td><td className="text-right">{fmtMoney((v as number) * 12, cur)}</td></tr>
                  ))}
                  <tr className="font-semibold"><td>Annual CTC</td><td className="text-right">—</td><td className="text-right">{fmtMoney(o.ctc_annual, cur)}</td></tr>
                </tbody>
              </table>
            </div>
            {o.additional_terms && <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{o.additional_terms}</p>}
          </Card>
        </div>
        <Card title="Activity">
          <ol className="space-y-4">
            {(history.data?.rows ?? []).map((h) => (
              <li key={h.id} className="text-sm">
                <p><span className="font-medium">{titleCase(h.action)}</span> <span className="text-slate-500">by {nameOf(h.actor_id)}</span></p>
                {h.comments && <p className="text-slate-600">“{h.comments}”</p>}
                <p className="text-xs text-slate-400">{fmtDateTime(h.created_at)}</p>
              </li>
            ))}
            <li className="text-sm"><p><span className="font-medium">Created</span> <span className="text-slate-500">by {o.created_by_name}</span></p><p className="text-xs text-slate-400">{fmtDateTime(o.created_at)}</p></li>
          </ol>
        </Card>
      </div>
      {editing && <OfferFormModal open offer={o} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      <ConfirmDialog open={deciding !== null} onClose={() => setDeciding(null)} loading={decide.isPending} title={deciding ? 'Approve offer' : 'Reject offer'}
        tone={deciding ? 'success' : 'danger'} confirmLabel={deciding ? 'Approve' : 'Reject'} message={`${o.candidate_name} · ${fmtMoney(o.ctc_annual, cur)}`}
        input={{ label: deciding ? 'Comments (optional)' : 'Reason', required: !deciding, multiline: true }} onConfirm={(c) => decide.mutate({ approve: !!deciding, comments: c })} />
      <ConfirmDialog open={withdrawing} onClose={() => setWithdrawing(false)} loading={withdraw.isPending} title="Withdraw offer?" tone="danger" confirmLabel="Withdraw"
        message="The secure link will stop working immediately." input={{ label: 'Reason', required: true }} onConfirm={(r) => withdraw.mutate(r)} />
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} loading={remove.isPending} title="Delete draft offer?" tone="danger" confirmLabel="Delete" onConfirm={() => remove.mutate()} />
      <Modal open={!!sentLink} onClose={() => setSentLink(null)} title="Offer sent" size="md" footer={<Button onClick={() => setSentLink(null)}>Done</Button>}>
        <p className="text-sm text-slate-600">The offer email with the PDF attached has been queued to <strong>{o.candidate_email}</strong>.
          {config.mode === 'demo' && ' Demo mode uses mock delivery — you can find the rendered email in the Email Center.'}</p>
        <p className="mt-4 text-xs font-medium uppercase text-slate-500">Secure acceptance link</p>
        <div className="mt-1 flex gap-2">
          <code className="flex-1 break-all rounded-lg bg-slate-50 p-2 text-xs">{sentLink}</code>
          <Button variant="secondary" size="sm" aria-label="Copy link" onClick={() => navigator.clipboard.writeText(sentLink ?? '').then(() => toast.success('Copied'), () => toast.error('Copy failed'))}><Copy className="h-4 w-4" /></Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">Personal to the candidate. Only its hash is stored; resending generates a new link and invalidates this one.</p>
      </Modal>
    </>
  );
}
