import type { Option, Tone } from '@/components/ui';

export const STAGES = [
  { value: 'applied', label: 'Applied', tone: 'gray', color: '#64748b' },
  { value: 'screening', label: 'Screening', tone: 'cyan', color: '#0891b2' },
  { value: 'shortlisted', label: 'Shortlisted', tone: 'blue', color: '#2563eb' },
  { value: 'interview', label: 'Interview', tone: 'violet', color: '#7c3aed' },
  { value: 'selected', label: 'Selected', tone: 'indigo', color: '#4f46e5' },
  { value: 'offered', label: 'Offered', tone: 'orange', color: '#ea580c' },
  { value: 'hired', label: 'Hired', tone: 'green', color: '#059669' },
  { value: 'on_hold', label: 'On hold', tone: 'yellow', color: '#d97706' },
  { value: 'rejected', label: 'Rejected', tone: 'red', color: '#e11d48' },
  { value: 'withdrawn', label: 'Withdrawn', tone: 'gray', color: '#94a3b8' },
] as const satisfies readonly { value: string; label: string; tone: Tone; color: string }[];

export const PIPELINE_COLUMNS = ['applied', 'screening', 'shortlisted', 'interview', 'selected', 'offered', 'hired', 'on_hold', 'rejected'];
export const MANUAL_STAGES = ['applied', 'screening', 'shortlisted', 'interview', 'selected', 'on_hold', 'rejected', 'withdrawn'];

export const stageInfo = (s: string) => STAGES.find((x) => x.value === s) ?? { value: s, label: s, tone: 'gray' as Tone, color: '#64748b' };

type ToneMap = Record<string, Tone>;
export const STATUS_TONES: Record<string, ToneMap> = {
  job: { draft: 'gray', published: 'green', on_hold: 'yellow', closed: 'red' },
  requisition: { draft: 'gray', pending_approval: 'yellow', approved: 'green', rejected: 'red', closed: 'gray' },
  offer: { draft: 'gray', pending_approval: 'yellow', approved: 'blue', rejected: 'red', sent: 'violet', accepted: 'green', declined: 'red', expired: 'orange', withdrawn: 'gray' },
  interview: { scheduled: 'blue', completed: 'green', cancelled: 'red', no_show: 'orange' },
  onboarding: { pending: 'yellow', in_progress: 'blue', completed: 'green', cancelled: 'red' },
  employee: { active: 'green', probation: 'blue', notice: 'yellow', inactive: 'gray', terminated: 'red' },
  leave: { pending: 'yellow', approved: 'green', rejected: 'red', cancelled: 'gray' },
  attendance: { present: 'green', absent: 'red', half_day: 'yellow', on_leave: 'violet', holiday: 'cyan', weekend: 'gray' },
  payroll: { draft: 'gray', processed: 'blue', paid: 'green' },
  email: { queued: 'yellow', sending: 'blue', sent: 'green', failed: 'red', skipped: 'gray' },
  company: { active: 'green', trial: 'blue', suspended: 'red' },
  priority: { low: 'gray', medium: 'blue', high: 'orange', urgent: 'red' },
  recommendation: { strong_hire: 'green', hire: 'blue', no_hire: 'orange', strong_no_hire: 'red' },
};

export const opts = (values: string[], label?: (v: string) => string): Option[] =>
  values.map((v) => ({ value: v, label: label ? label(v) : v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }));

export const EMPLOYMENT_TYPES = opts(['full_time', 'part_time', 'contract', 'intern']);
export const WORK_MODES = opts(['onsite', 'remote', 'hybrid']);
export const EMPLOYEE_STATUSES = opts(['active', 'probation', 'notice', 'inactive', 'terminated']);
export const GENDERS = opts(['female', 'male', 'other', 'undisclosed']);
export const PRIORITIES = opts(['low', 'medium', 'high', 'urgent']);
export const INTERVIEW_TYPES = opts(['video', 'phone', 'onsite', 'technical', 'hr']);
export const SOURCES = opts(['careers', 'referral', 'linkedin', 'agency', 'direct', 'job_board', 'other']);
export const ATTENDANCE_STATUSES = opts(['present', 'absent', 'half_day', 'on_leave', 'holiday']);
export const RECOMMENDATIONS = opts(['strong_hire', 'hire', 'no_hire', 'strong_no_hire']);
export const DOC_TYPES = opts(['resume', 'cover_letter', 'id_proof', 'certificate', 'other']);
export const PLANS = opts(['trial', 'starter', 'growth', 'enterprise']);
export const MONTHS: Option[] = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(2000, i, 1).toLocaleString('en', { month: 'long' }) }));

export const RESUME_MIME = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
