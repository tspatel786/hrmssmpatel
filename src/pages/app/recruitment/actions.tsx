import { format } from 'date-fns';
import { Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { FormModal, type FieldDef } from '@/components/FormModal';
import { Button, Field, Input, Modal, Select, Textarea, cx } from '@/components/ui';
import { api } from '@/lib/backend';
import { INTERVIEW_TYPES, MANUAL_STAGES, RECOMMENDATIONS, stageInfo } from '@/lib/constants';
import { useAction } from '@/lib/hooks';
import { useMembers } from '@/lib/lookups';
import { reqNum, reqStr } from '@/lib/schemas';

export function StageDialog({ open, onClose, applicationId, current, initialStage, candidateName }: {
  open: boolean; onClose: () => void; applicationId: string; current: string; initialStage?: string; candidateName?: string;
}) {
  const [stage, setStage] = useState(initialStage ?? '');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) { setStage(initialStage ?? ''); setNote(''); setReason(''); }
  }, [open, initialStage]);
  const change = useAction(() => api.db.rpc('change_application_stage', { p_application: applicationId, p_stage: stage, p_note: note || null, p_reason: reason || null }), {
    success: `Moved to ${stageInfo(stage).label}${['shortlisted', 'rejected', 'on_hold', 'selected'].includes(stage) ? ' · candidate email queued' : ''}`,
    onSuccess: onClose,
  });
  const emails: Record<string, string> = {
    shortlisted: 'The candidate will receive a “shortlisted” email.',
    rejected: 'The candidate will receive a polite rejection email.',
    on_hold: 'The candidate will be notified that the application is on hold.',
    selected: 'The candidate will receive a “selected” email. You can then create an offer.',
  };
  return (
    <Modal open={open} onClose={onClose} title="Change stage" description={candidateName} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={change.isPending} disabled={!stage || stage === current || (stage === 'rejected' && reason.trim().length < 3)} onClick={() => change.mutate()}>Update stage</Button></>}>
      <div className="space-y-4">
        <Field label="New stage" required>
          <Select value={stage} onChange={(e) => setStage(e.target.value)} placeholder="Select stage"
            options={MANUAL_STAGES.filter((s) => s !== current).map((s) => ({ value: s, label: stageInfo(s).label }))} />
        </Field>
        {emails[stage] && <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">{emails[stage]}</p>}
        {stage === 'rejected' && <Field label="Rejection reason (internal)" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <Field label="Note (optional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Visible in the stage history" /></Field>
      </div>
    </Modal>
  );
}

const ivSchema = z.object({
  round_name: reqStr(2, 80, 'Round name'),
  interview_type: z.string(),
  scheduled_at: z.string().min(1, 'Date & time is required').refine((v) => new Date(v).getTime() > Date.now() - 5 * 60000, 'Must be in the future'),
  duration_minutes: reqNum(15, 480, 'Duration is required'),
  meeting_link: z.string().trim().url('Enter a full URL').or(z.literal('')).optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});
type IvValues = z.infer<typeof ivSchema>;

export interface InterviewLike {
  id: string; round_name: string; interview_type: string; scheduled_at: string; duration_minutes: number;
  meeting_link: string | null; location: string | null; notes: string | null; panelist_ids: string[] | null;
}

export function ScheduleInterviewModal({ open, onClose, applicationId, candidateName, interview, defaultDate }: {
  open: boolean; onClose: () => void; applicationId?: string; candidateName?: string; interview?: InterviewLike | null; defaultDate?: Date;
}) {
  const members = useMembers();
  const [panel, setPanel] = useState<string[]>(interview?.panelist_ids ?? []);
  const [panelError, setPanelError] = useState('');
  useEffect(() => {
    if (open) { setPanel(interview?.panelist_ids ?? []); setPanelError(''); }
  }, [open, interview]);
  const save = useAction(async (v: IvValues) => {
    if (!panel.length) { setPanelError('Select at least one interviewer'); throw new Error('Select at least one interviewer'); }
    const at = new Date(v.scheduled_at).toISOString();
    if (interview) {
      return api.db.rpc('reschedule_interview', { p_interview: interview.id, p_at: at, p_duration: v.duration_minutes, p_location: v.location ?? '', p_meeting_link: v.meeting_link ?? '', p_panelists: panel });
    }
    return api.db.rpc('schedule_interview', {
      p_application: applicationId, p_round: v.round_name, p_type: v.interview_type, p_at: at, p_duration: v.duration_minutes,
      p_location: v.location ?? '', p_meeting_link: v.meeting_link ?? '', p_panelists: panel, p_notes: v.notes || null,
    });
  }, { success: interview ? 'Interview updated · notifications queued' : 'Interview scheduled · candidate and panel notified', silent: true });

  const start = defaultDate ?? (() => { const d = new Date(Date.now() + 86400000); d.setHours(11, 0, 0, 0); return d; })();
  const fields: FieldDef<IvValues>[] = [
    { name: 'round_name', label: 'Round', required: true, disabled: !!interview },
    { name: 'interview_type', label: 'Type', type: 'select', options: INTERVIEW_TYPES, required: true, disabled: !!interview },
    { name: 'scheduled_at', label: 'Date & time', type: 'datetime-local', required: true },
    { name: 'duration_minutes', label: 'Duration (minutes)', type: 'number', required: true, min: 15, step: '15' },
    { name: 'meeting_link', label: 'Meeting link', type: 'url', placeholder: 'https://meet…' },
    { name: 'location', label: 'Location', placeholder: 'Office / room' },
    { name: 'notes', label: 'Internal notes', type: 'textarea', rows: 2, hidden: !!interview },
  ];
  return (
    <FormModal open={open} onClose={onClose} title={interview ? 'Reschedule interview' : 'Schedule interview'} description={candidateName}
      schema={ivSchema} fields={fields} submitLabel={interview ? 'Save & notify' : 'Schedule & notify'}
      defaultValues={(interview
        ? { ...interview, scheduled_at: format(new Date(interview.scheduled_at), "yyyy-MM-dd'T'HH:mm") }
        : { round_name: 'Round 1', interview_type: 'video', duration_minutes: 60, scheduled_at: format(start, "yyyy-MM-dd'T'HH:mm") }) as never}
      onSubmit={(v) => save.mutateAsync(v)}>
      <Field label="Interview panel" required className="mt-4" error={panelError} hint="Conflicting interviews for panel members are detected automatically.">
        <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {members.rows.length === 0 && <p className="p-2 text-sm text-slate-500">No team members found.</p>}
          {members.rows.map((m) => {
            const id = String(m.user_id);
            return (
              <label key={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50">
                <input type="checkbox" className="rounded border-slate-300 text-brand-600" checked={panel.includes(id)}
                  onChange={(e) => { setPanelError(''); setPanel((p) => (e.target.checked ? [...p, id] : p.filter((x) => x !== id))); }} />
                <span className="font-medium">{String(m.full_name || m.email)}</span>
                <span className="text-xs text-slate-500">{String(m.role_name)}</span>
              </label>
            );
          })}
        </div>
      </Field>
    </FormModal>
  );
}

function Stars({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-slate-700">{label}</span>
      <div className="flex gap-1" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => onChange(n)}>
            <Star className={cx('h-6 w-6 transition', n <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-300 hover:text-amber-300')} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function FeedbackModal({ open, onClose, interviewId, title, existing }: {
  open: boolean; onClose: () => void; interviewId: string; title?: string;
  existing?: { overall_rating: number; technical_rating: number | null; communication_rating: number | null; culture_rating: number | null; recommendation: string; strengths: string | null; weaknesses: string | null; comments: string | null } | null;
}) {
  const [r, setR] = useState({ overall: 0, technical: 0, communication: 0, culture: 0 });
  const [rec, setRec] = useState('');
  const [text, setText] = useState({ strengths: '', weaknesses: '', comments: '' });
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setError('');
    setR({ overall: existing?.overall_rating ?? 0, technical: existing?.technical_rating ?? 0, communication: existing?.communication_rating ?? 0, culture: existing?.culture_rating ?? 0 });
    setRec(existing?.recommendation ?? '');
    setText({ strengths: existing?.strengths ?? '', weaknesses: existing?.weaknesses ?? '', comments: existing?.comments ?? '' });
  }, [open, existing]);
  const submit = useAction(() => api.db.rpc('submit_interview_feedback', {
    p_interview: interviewId, p_overall: r.overall, p_technical: r.technical || null, p_communication: r.communication || null, p_culture: r.culture || null,
    p_recommendation: rec, p_strengths: text.strengths || null, p_weaknesses: text.weaknesses || null, p_comments: text.comments || null,
  }), { success: 'Feedback submitted', onSuccess: onClose, silent: true });
  return (
    <Modal open={open} onClose={onClose} title={existing ? 'Update feedback' : 'Interview feedback'} description={title} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={submit.isPending} onClick={() => {
          if (!r.overall) return setError('Overall rating is required');
          if (!rec) return setError('Select a recommendation');
          submit.mutate(undefined, { onError: (e) => setError(e.message) });
        }}>Submit feedback</Button></>}>
      <div className="space-y-4">
        {error && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        <div className="space-y-2 rounded-lg bg-slate-50 p-4">
          <Stars label="Overall *" value={r.overall} onChange={(v) => setR({ ...r, overall: v })} />
          <Stars label="Technical" value={r.technical} onChange={(v) => setR({ ...r, technical: v })} />
          <Stars label="Communication" value={r.communication} onChange={(v) => setR({ ...r, communication: v })} />
          <Stars label="Culture fit" value={r.culture} onChange={(v) => setR({ ...r, culture: v })} />
        </div>
        <Field label="Recommendation" required>
          <div className="grid grid-cols-2 gap-2">
            {RECOMMENDATIONS.map((o) => (
              <button key={o.value} type="button" onClick={() => setRec(o.value)} aria-pressed={rec === o.value}
                className={cx('rounded-lg border px-3 py-2 text-sm font-medium transition', rec === o.value ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50')}>
                {o.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Strengths"><Textarea rows={2} value={text.strengths} onChange={(e) => setText({ ...text, strengths: e.target.value })} /></Field>
        <Field label="Areas of concern"><Textarea rows={2} value={text.weaknesses} onChange={(e) => setText({ ...text, weaknesses: e.target.value })} /></Field>
        <Field label="Additional comments"><Textarea rows={2} value={text.comments} onChange={(e) => setText({ ...text, comments: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

export function CancelInterviewDialog({ open, onClose, interviewId }: { open: boolean; onClose: () => void; interviewId: string }) {
  const [reason, setReason] = useState('');
  const cancel = useAction(() => api.db.rpc('cancel_interview', { p_interview: interviewId, p_reason: reason || null }), { success: 'Interview cancelled · candidate notified', onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Cancel interview" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Keep</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel interview</Button></>}>
      <p className="text-sm text-slate-600">The candidate will receive a cancellation email.</p>
      <Field label="Reason (included in the email)" className="mt-4"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
