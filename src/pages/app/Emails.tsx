import { Eye, Mail, Pencil, RotateCcw, Send } from 'lucide-react';
import { useState } from 'react';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { Badge, Button, Card, Drawer, Field, Input, Modal, PageHeader, PageLoader, Tabs, Textarea, Toggle } from '@/components/ui';
import { useCompany, useSession } from '@/contexts/session';
import { api } from '@/lib/backend';
import { config } from '@/lib/config';
import { opts } from '@/lib/constants';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { useAction, useList, useTable } from '@/lib/hooks';

interface Template { id: string; key: string; name: string; description: string | null; subject: string; body_html: string; is_active: boolean; updated_at: string }
interface Log { id: string; template_key: string; to_email: string; to_name: string | null; subject: string; body_html: string; status: string; attempts: number; last_error: string | null; provider: string | null; provider_message_id: string | null; attachments: { filename: string }[]; sent_at: string | null; created_at: string; dedupe_key: string }

const VARS = ['candidate_name', 'job_title', 'company_name', 'interview_date', 'interview_time', 'timezone', 'round_name', 'interview_type', 'duration', 'location', 'meeting_link', 'ctc', 'joining_date', 'expiry_date', 'offer_link', 'employee_name', 'employee_code', 'login_link', 'invite_link', 'role_name', 'leave_type', 'start_date', 'end_date', 'days', 'decision', 'note', 'period', 'net_pay', 'work_location', 'reporting_time', 'reason'];

/** Renders HTML email in a sandboxed iframe (no scripts) to keep the app safe. */
function EmailPreview({ html }: { html: string }) {
  return <iframe title="Email preview" sandbox="" srcDoc={html} className="h-[480px] w-full rounded-lg border border-slate-200 bg-white" />;
}

function Templates() {
  const { companyId } = useCompany();
  const { user } = useSession();
  const q = useList<Template>(companyId ? { table: 'email_templates', filters: [{ column: 'company_id', op: 'eq', value: companyId }], order: [{ column: 'name' }], range: [0, 99] } : null);
  const [editing, setEditing] = useState<Template | null>(null);
  const [draft, setDraft] = useState({ subject: '', body_html: '' });
  const [testing, setTesting] = useState<Template | null>(null);
  const [testTo, setTestTo] = useState(user?.email ?? '');
  const [error, setError] = useState('');
  const save = useAction(() => {
    if (draft.subject.trim().length < 3) throw new Error('Subject is required');
    if (draft.body_html.trim().length < 10) throw new Error('Body is too short');
    return api.db.update('email_templates', editing!.id, { subject: draft.subject.trim(), body_html: draft.body_html });
  }, { success: 'Template saved', onSuccess: () => setEditing(null), silent: true });
  const toggle = useAction((t: Template) => api.db.update('email_templates', t.id, { is_active: !t.is_active }), { success: 'Template updated' });
  const test = useAction(() => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testTo)) throw new Error('Enter a valid email');
    return api.db.rpc('send_test_email', { p_company: companyId, p_template: testing!.key, p_to: testTo });
  }, { success: config.mode === 'demo' ? 'Test email logged (mock delivery)' : 'Test email queued', onSuccess: () => setTesting(null) });
  const previewHtml = (body: string) => body.replace(/\{\{(\w+)\}\}/g, (_m, k) => `<mark style="background:#fef3c7">${k}</mark>`);

  if (q.isLoading) return <PageLoader />;
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(q.data?.rows ?? []).map((t) => (
          <div key={t.id} className="card flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <div><p className="font-semibold text-slate-900">{t.name}</p><p className="text-xs text-slate-500">{t.description}</p></div>
              <Toggle checked={t.is_active} onChange={() => toggle.mutate(t)} label={`${t.is_active ? 'Disable' : 'Enable'} ${t.name}`} />
            </div>
            <p className="mt-3 line-clamp-2 flex-1 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600">{t.subject}</p>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-slate-400">Updated {fmtRelative(t.updated_at)}</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" icon={<Send className="h-3.5 w-3.5" />} onClick={() => setTesting(t)}>Test</Button>
                <Button size="sm" variant="secondary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setDraft({ subject: t.subject, body_html: t.body_html }); setError(''); setEditing(t); }}>Edit</Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Edit template · ${editing?.name ?? ''}`} size="xl"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined, { onError: (e) => setError(e.message) })}>Save template</Button></>}>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            {error && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
            <Field label="Subject" required><Input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} maxLength={250} /></Field>
            <Field label="Body (HTML)" required hint="Values are HTML-escaped automatically. The company header and footer are added for you.">
              <Textarea rows={14} className="font-mono text-xs" value={draft.body_html} onChange={(e) => setDraft({ ...draft, body_html: e.target.value })} />
            </Field>
            <div>
              <p className="label">Insert variable</p>
              <div className="flex flex-wrap gap-1">{VARS.map((v) => <button key={v} type="button" className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 hover:bg-brand-100" onClick={() => setDraft({ ...draft, body_html: `${draft.body_html}{{${v}}}` })}>{`{{${v}}}`}</button>)}</div>
            </div>
          </div>
          <div><p className="label">Preview</p><p className="mb-2 text-sm font-medium">{draft.subject}</p><EmailPreview html={previewHtml(draft.body_html)} /></div>
        </div>
      </Modal>
      <Modal open={!!testing} onClose={() => setTesting(null)} title="Send test email" description={testing?.name} size="sm"
        footer={<><Button variant="secondary" onClick={() => setTesting(null)}>Cancel</Button><Button loading={test.isPending} onClick={() => test.mutate()}>Send test</Button></>}>
        <p className="text-sm text-slate-600">Rendered with sample data. Use a test inbox you control.</p>
        <Field label="Recipient" className="mt-4"><Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

function Logs() {
  const { companyId } = useCompany();
  const table = useTable({ table: 'email_logs', companyId, searchColumns: ['to_email', 'subject', 'template_key'], defaultSort: { column: 'created_at', ascending: false } });
  const [viewing, setViewing] = useState<Log | null>(null);
  const retry = useAction((id: string) => api.db.rpc('retry_email', { p_id: id }), { success: 'Email re-queued' });
  const process = useAction(() => api.processEmails(), { success: 'Delivery triggered' });
  const columns: Column<Log>[] = [
    { key: 'to_email', header: 'Recipient', sortable: true, render: (l) => <span><span className="font-medium">{l.to_name || l.to_email}</span>{l.to_name && <span className="block text-xs text-slate-500">{l.to_email}</span>}</span> },
    { key: 'subject', header: 'Subject', render: (l) => <span className="line-clamp-1 max-w-[320px]">{l.subject}</span> },
    { key: 'template_key', header: 'Template', hideOnMobile: true, render: (l) => <Badge>{l.template_key}</Badge> },
    { key: 'status', header: 'Status', sortable: true, render: (l) => <div><StatusBadge kind="email" value={l.status} />{l.provider === 'mock' && <span className="ml-1 text-[10px] text-slate-400">mock</span>}</div> },
    { key: 'created_at', header: 'Queued', sortable: true, hideOnMobile: true, render: (l) => fmtDateTime(l.created_at) },
  ];
  return (
    <>
      <DataTable table={table} columns={columns} searchPlaceholder="Search recipient or subject" exportName="email-logs" onRowClick={setViewing}
        filters={[{ key: 'status', label: 'Status', options: opts(['queued', 'sending', 'sent', 'failed', 'skipped']) }]}
        toolbar={<Button size="sm" variant="secondary" icon={<Send className="h-4 w-4" />} onClick={() => process.mutate()} loading={process.isPending}>Process queue</Button>}
        rowActions={(l) => (['failed', 'skipped'].includes(l.status) ? <Button size="sm" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => retry.mutate(l.id)}>Retry</Button> : <Button size="sm" variant="ghost" aria-label="View email" onClick={() => setViewing(l)}><Eye className="h-4 w-4" /></Button>)}
        empty={{ icon: <Mail className="h-6 w-6" />, title: 'No emails yet', description: 'Automatic emails (applications, interviews, offers…) are logged here.' }} />
      <Drawer open={!!viewing} onClose={() => setViewing(null)} title="Email details" width="max-w-2xl">
        {viewing && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div><p className="text-xs text-slate-500">To</p><p className="font-medium">{viewing.to_name} &lt;{viewing.to_email}&gt;</p></div>
              <div><p className="text-xs text-slate-500">Status</p><StatusBadge kind="email" value={viewing.status} /></div>
              <div><p className="text-xs text-slate-500">Queued</p><p>{fmtDateTime(viewing.created_at)}</p></div>
              <div><p className="text-xs text-slate-500">Sent</p><p>{fmtDateTime(viewing.sent_at)}{viewing.provider && ` via ${viewing.provider}`}</p></div>
              <div><p className="text-xs text-slate-500">Attempts</p><p>{viewing.attempts}</p></div>
              <div><p className="text-xs text-slate-500">Dedupe key</p><p className="break-all font-mono text-xs">{viewing.dedupe_key}</p></div>
            </div>
            {viewing.last_error && <p className="rounded-lg bg-rose-50 p-3 text-rose-700">{viewing.last_error}</p>}
            {viewing.attachments?.length > 0 && <p>Attachments: {viewing.attachments.map((a) => <Badge key={a.filename} tone="blue">{a.filename}</Badge>)}</p>}
            <p className="font-semibold">{viewing.subject}</p>
            {viewing.body_html ? <EmailPreview html={viewing.body_html} /> : <p className="text-slate-500">No body (template missing).</p>}
          </div>
        )}
      </Drawer>
    </>
  );
}

export function Emails() {
  const [tab, setTab] = useState<'logs' | 'templates'>('logs');
  return (
    <>
      <PageHeader title="Email Center" description="Automated candidate & employee emails: delivery logs and editable templates." />
      {config.mode === 'demo' && <Card className="mb-5 border-amber-200 bg-amber-50/60"><p className="text-sm text-amber-800"><strong>Mock delivery mode:</strong> emails are rendered and logged but not sent to real inboxes. Configure Supabase and an email provider (Resend) to deliver for real.</p></Card>}
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[{ value: 'logs', label: 'Delivery logs' }, { value: 'templates', label: 'Templates' }]} />
      {tab === 'logs' ? <Logs /> : <Templates />}
    </>
  );
}
