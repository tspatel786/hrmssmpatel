import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, CheckCircle2, Download, Megaphone, Pin, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Checkbox, ConfirmDialog, EmptyState, Field, Input, Modal, PageLoader, Select, Textarea } from '@/components/ui';
import { useChat } from '@/contexts/chat';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { downloadBlob } from '@/lib/csv';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { useDepartments } from '@/lib/lookups';

interface Ann {
  id: string; title: string; body: string; department_id: string | null; department_name: string | null; pinned: boolean; requires_ack: boolean;
  attachment_path: string | null; attachment_name: string | null; author_name: string | null; created_at: string; ack_count: number; my_ack_at: string | null;
}

export function Announcements({ onBack }: { onBack: () => void }) {
  const { companyId, can } = useCompany();
  const { tick } = useChat();
  const qc = useQueryClient();
  const departments = useDepartments();
  const manage = can('announcements.manage');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Ann | null>(null);
  const [form, setForm] = useState({ title: '', body: '', department_id: '', pinned: false, requires_ack: false });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['announcements', companyId, tick],
    enabled: !!companyId,
    queryFn: () => api.db.list<Ann>({ table: 'v_announcements', filters: [{ column: 'company_id', op: 'eq', value: companyId }], order: [{ column: 'pinned', ascending: false }, { column: 'created_at', ascending: false }], range: [0, 99] }),
  });
  const reload = () => qc.invalidateQueries({ queryKey: ['announcements'] });
  const publish = async () => {
    if (form.title.trim().length < 3) return toast.error('Title must be at least 3 characters');
    if (form.body.trim().length < 3) return toast.error('Message is required');
    if (file && file.size > 10 * 1024 * 1024) return toast.error('Attachment must be 10 MB or smaller');
    setBusy(true);
    try {
      let attachment_path: string | null = null;
      if (file) {
        attachment_path = `${companyId}/announcements/${crypto.randomUUID()}/${file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100)}`;
        await api.storage.upload('chat-attachments', attachment_path, file, file.type || 'application/pdf');
      }
      await api.db.insert('announcements', { company_id: companyId, title: form.title.trim(), body: form.body.trim(), department_id: form.department_id || null,
        pinned: form.pinned, requires_ack: form.requires_ack, attachment_path, attachment_name: file?.name ?? null });
      toast.success('Announcement published · members notified');
      setCreating(false);
      setForm({ title: '', body: '', department_id: '', pinned: false, requires_ack: false });
      setFile(null);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); await reload(); } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center gap-3 border-b border-slate-200 p-4">
        <button type="button" className="btn-ghost p-2 lg:hidden" onClick={onBack} aria-label="Back"><ArrowLeft className="h-5 w-5" /></button>
        <div className="flex-1"><h2 className="flex items-center gap-2 font-semibold"><Megaphone className="h-5 w-5 text-brand-600" /> Announcements</h2><p className="text-xs text-slate-500">Company-wide and department updates</p></div>
        {manage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New announcement</Button>}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {q.isLoading ? <PageLoader /> : (q.data?.rows ?? []).length === 0 ? <EmptyState icon={<Megaphone className="h-6 w-6" />} title="No announcements yet" description={manage ? 'Publish your first company announcement.' : 'Company announcements will appear here.'} /> : (
          <ul className="mx-auto max-w-3xl space-y-4">
            {q.data!.rows.map((a) => (
              <li key={a.id} className={clsx('card p-5', a.pinned && 'border-amber-200 bg-amber-50/40')}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="flex items-center gap-2 font-semibold text-slate-900">{a.pinned && <Pin className="h-4 w-4 text-amber-500" aria-label="Pinned" />}{a.title}</h3>
                    <p className="text-xs text-slate-500">{a.author_name} · <span title={fmtDateTime(a.created_at)}>{fmtRelative(a.created_at)}</span></p>
                  </div>
                  <div className="flex gap-1">{a.department_name ? <Badge tone="violet">{a.department_name}</Badge> : <Badge tone="blue">Company-wide</Badge>}{a.requires_ack && <Badge tone="yellow">Acknowledgement required</Badge>}</div>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{a.body}</p>
                {a.attachment_path && (
                  <button type="button" className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
                    onClick={async () => { try { downloadBlob(a.attachment_name ?? 'attachment', await api.storage.download('chat-attachments', a.attachment_path!)); } catch (e) { toast.error((e as Error).message); } }}>
                    <Download className="h-4 w-4" /> {a.attachment_name}
                  </button>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  {a.requires_ack && (a.my_ack_at
                    ? <span className="flex items-center gap-1 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Acknowledged {fmtRelative(a.my_ack_at)}</span>
                    : <Button size="sm" variant="success" onClick={() => act(() => api.db.rpc('announcement_acknowledge', { p_announcement: a.id }), 'Acknowledged')}>Acknowledge</Button>)}
                  {manage && (
                    <span className="ml-auto flex items-center gap-1">
                      {a.requires_ack && <span className="mr-2 text-xs text-slate-500">{a.ack_count} acknowledged</span>}
                      <Button size="sm" variant="ghost" onClick={() => act(() => api.db.update('announcements', a.id, { pinned: !a.pinned }), a.pinned ? 'Unpinned' : 'Pinned')}>{a.pinned ? 'Unpin' : 'Pin'}</Button>
                      <Button size="sm" variant="ghost" aria-label="Delete announcement" onClick={() => setDeleting(a)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Modal open={creating} onClose={() => setCreating(false)} title="New announcement" size="lg"
        footer={<><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button loading={busy} onClick={publish}>Publish</Button></>}>
        <div className="space-y-4">
          <Field label="Title" required><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={160} /></Field>
          <Field label="Message" required><Textarea rows={6} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={10000} /></Field>
          <Field label="Audience"><Select value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })} options={departments.options} placeholder="Entire company" /></Field>
          <Field label="Attachment" hint="Optional, max 10 MB"><input type="file" className="block w-full text-sm" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <Checkbox label="Pin to top" checked={form.pinned} onChange={(v) => setForm({ ...form, pinned: v })} />
          <Checkbox label="Require acknowledgement" description="Members must confirm they have read it" checked={form.requires_ack} onChange={(v) => setForm({ ...form, requires_ack: v })} />
        </div>
      </Modal>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete announcement?" tone="danger" confirmLabel="Delete"
        onConfirm={() => { const a = deleting!; setDeleting(null); void act(async () => { await api.db.remove('announcements', a.id); if (a.attachment_path) await api.storage.remove('chat-attachments', a.attachment_path).catch(() => undefined); }, 'Announcement deleted'); }} />
    </div>
  );
}
