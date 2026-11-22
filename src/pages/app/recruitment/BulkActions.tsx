// Bulk actions for applicant and candidate tables (used via DataTable's bulkActions prop).
import { Download, Tag, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/backend';
import { STAGES } from '@/lib/constants';
import { downloadCsv } from '@/lib/csv';
import { useAction } from '@/lib/hooks';
import type { Application, Candidate } from './Candidates';

const MOVABLE = STAGES.filter((s) => ['applied', 'screening', 'shortlisted', 'interview', 'selected', 'on_hold'].includes(s.value));

interface BulkResult { updated: number; failed: { id: string; error: string }[] }

function reportResult(r: BulkResult, rows: Application[]) {
  if (r.updated) toast.success(`${r.updated} application${r.updated === 1 ? '' : 's'} updated`);
  if (r.failed.length) {
    const name = (id: string) => rows.find((x) => x.id === id)?.candidate_name ?? 'Application';
    toast.error(`${r.failed.length} could not be updated: ${r.failed.slice(0, 3).map((f) => `${name(f.id)} — ${f.error}`).join('; ')}${r.failed.length > 3 ? '…' : ''}`, { duration: 8000 });
  }
}

export function BulkApplicationActions({ selected, clear }: { selected: Application[]; clear: () => void }) {
  const [stage, setStage] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const ids = selected.map((a) => a.id);
  const move = useAction((s: string) => api.db.rpc<BulkResult>('bulk_change_application_stage', { p_applications: ids, p_stage: s }),
    { onSuccess: (r) => { reportResult(r, selected); setStage(''); clear(); } });
  const reject = useAction(() => api.db.rpc<BulkResult>('bulk_change_application_stage', { p_applications: ids, p_stage: 'rejected', p_reason: reason.trim() }),
    { onSuccess: (r) => { reportResult(r, selected); setRejecting(false); setReason(''); clear(); } });
  const exportRows = () => downloadCsv(`applicants-selected-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Candidate', 'Email', 'Phone', 'Stage', 'Experience (yrs)', 'Applied'],
    selected.map((a) => [a.candidate_name, a.candidate_email, a.candidate_phone, a.stage, a.experience_years, a.applied_at]));
  return (
    <>
      <Select className="w-44 h-9" value={stage} onChange={(e) => setStage(e.target.value)} options={MOVABLE.map((s) => ({ value: s.value, label: s.label }))} placeholder="Move to stage…" aria-label="Move to stage" />
      <Button size="sm" disabled={!stage} loading={move.isPending} onClick={() => move.mutate(stage)}>Apply</Button>
      <Button size="sm" variant="secondary" icon={<XCircle className="h-4 w-4 text-rose-500" />} onClick={() => setRejecting(true)}>Reject</Button>
      <Button size="sm" variant="secondary" icon={<Download className="h-4 w-4" />} onClick={exportRows}>Export</Button>
      <Modal open={rejecting} onClose={() => setRejecting(false)} size="sm" title={`Reject ${selected.length} application${selected.length === 1 ? '' : 's'}?`}
        description="Each candidate's rejection email is sent according to your email templates."
        footer={<><Button variant="secondary" onClick={() => setRejecting(false)}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={reject.isPending} onClick={() => reject.mutate()}>Reject</Button></>}>
        <Field label="Rejection reason" required hint="Recorded on each application (min 3 characters)"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

export function BulkCandidateActions({ selected, clear }: { selected: Candidate[]; clear: () => void }) {
  const [tag, setTag] = useState('');
  const ids = selected.map((c) => c.id);
  const run = useAction((remove: boolean) => api.db.rpc<number>('bulk_tag_candidates', { p_candidates: ids, p_tag: tag, p_remove: remove }),
    { success: (n) => `${n} candidate${n === 1 ? '' : 's'} updated`, onSuccess: () => { setTag(''); clear(); } });
  const exportRows = () => downloadCsv(`candidates-selected-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Name', 'Email', 'Phone', 'Current title', 'Experience (yrs)', 'Skills', 'Tags', 'Latest stage'],
    selected.map((c) => [c.full_name, c.email, c.phone, c.current_title, c.experience_years, c.skills.join('; '), c.tags.join('; '), c.latest_stage]));
  return (
    <>
      <Input className="w-40 py-1.5" placeholder="Tag, e.g. campus" value={tag} maxLength={40} onChange={(e) => setTag(e.target.value)} aria-label="Tag" />
      <Button size="sm" icon={<Tag className="h-4 w-4" />} disabled={!tag.trim()} loading={run.isPending} onClick={() => run.mutate(false)}>Add tag</Button>
      <Button size="sm" variant="secondary" disabled={!tag.trim()} loading={run.isPending} onClick={() => run.mutate(true)}>Remove tag</Button>
      <Button size="sm" variant="secondary" icon={<Download className="h-4 w-4" />} onClick={exportRows}>Export</Button>
    </>
  );
}
