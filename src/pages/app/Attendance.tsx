import { addDays, addMonths, eachDayOfInterval, endOfMonth, format, getISODay, startOfMonth } from 'date-fns';
import clsx from 'clsx';
import { CalendarCheck, ChevronLeft, ChevronRight, LogIn, LogOut, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { FormModal, type FieldDef } from '@/components/FormModal';
import { Avatar, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal, PageHeader, PageLoader, SearchInput, Select, StatCard, Tabs, Textarea } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { ATTENDANCE_STATUSES } from '@/lib/constants';
import { fmtDate, fmtTime, titleCase } from '@/lib/format';
import { useAction, useList, useRpc, useTable } from '@/lib/hooks';
import { useDepartments } from '@/lib/lookups';
import { reqDate, reqStr } from '@/lib/schemas';

interface Rec { id: string; employee_id: string; attendance_date: string; check_in: string | null; check_out: string | null; status: string; work_minutes: number | null; source: string; notes: string | null; employee_name: string; employee_code: string; department_name: string | null; department_id: string | null }
interface Holiday { id: string; name: string; holiday_date: string; is_optional: boolean }
interface Emp { id: string; full_name: string; employee_code: string; department_id: string | null; department_name: string | null }

const DOT: Record<string, string> = { present: 'bg-emerald-500', absent: 'bg-rose-500', half_day: 'bg-amber-500', on_leave: 'bg-violet-500', holiday: 'bg-cyan-500' };

function MyAttendance({ companyId, employeeId }: { companyId: string; employeeId: string }) {
  const { company } = useCompany();
  const [month, setMonth] = useState(startOfMonth(new Date()));
  const me = useRpc<{ today: { check_in: string | null; check_out: string | null; status: string } | null }>('my_dashboard', { p_company: companyId });
  const recs = useList<Rec>({ table: 'attendance_records', filters: [{ column: 'employee_id', op: 'eq', value: employeeId }, { column: 'attendance_date', op: 'gte', value: format(month, 'yyyy-MM-dd') }, { column: 'attendance_date', op: 'lte', value: format(endOfMonth(month), 'yyyy-MM-dd') }], range: [0, 40] });
  const hol = useList<Holiday>({ table: 'holidays', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'holiday_date', op: 'gte', value: format(month, 'yyyy-MM-dd') }, { column: 'holiday_date', op: 'lte', value: format(endOfMonth(month), 'yyyy-MM-dd') }] });
  const clockIn = useAction(() => api.db.rpc('clock_in', { p_company: companyId }), { success: 'Clocked in' });
  const clockOut = useAction(() => api.db.rpc('clock_out', { p_company: companyId }), { success: 'Clocked out' });
  const t = me.data?.today;
  const byDate = new Map((recs.data?.rows ?? []).map((r) => [r.attendance_date, r]));
  const hByDate = new Map((hol.data?.rows ?? []).map((h) => [h.holiday_date, h]));
  const days = eachDayOfInterval({ start: month, end: endOfMonth(month) });
  const lead = getISODay(month) - 1;
  const rows = recs.data?.rows ?? [];
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const hours = rows.reduce((a, r) => a + (r.work_minutes ?? 0), 0) / 60;
  const working = company?.working_days ?? [1, 2, 3, 4, 5];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
        <Card title="Today">
          <p className="text-3xl font-semibold tabular-nums">{format(new Date(), 'hh:mm a')}</p>
          <p className="text-sm text-slate-500">{format(new Date(), 'EEEE, dd MMMM yyyy')}</p>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">In</p><p className="font-semibold">{t?.check_in ? fmtTime(t.check_in) : '—'}</p></div>
            <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Out</p><p className="font-semibold">{t?.check_out ? fmtTime(t.check_out) : '—'}</p></div>
          </div>
          <div className="mt-4">
            {!t?.check_in ? <Button className="w-full" icon={<LogIn className="h-4 w-4" />} loading={clockIn.isPending} onClick={() => clockIn.mutate()}>Clock in</Button>
              : !t.check_out ? <Button variant="secondary" className="w-full" icon={<LogOut className="h-4 w-4" />} loading={clockOut.isPending} onClick={() => clockOut.mutate()}>Clock out</Button>
                : <p className="rounded-lg bg-emerald-50 py-2 text-center text-sm font-medium text-emerald-700">Completed · {titleCase(t.status)}</p>}
          </div>
          <p className="mt-3 text-xs text-slate-500">Office hours {company?.work_start?.slice(0, 5)} – {company?.work_end?.slice(0, 5)}. Less than 4 hours counts as a half day.</p>
        </Card>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Present" value={count('present')} tone="green" />
          <StatCard label="Half days" value={count('half_day')} tone="amber" />
          <StatCard label="On leave" value={count('on_leave')} tone="violet" />
          <StatCard label="Hours worked" value={hours.toFixed(1)} tone="blue" hint={format(month, 'MMMM')} />
        </div>
      </div>
      <Card title={format(month, 'MMMM yyyy')} actions={<>
        <Button size="sm" variant="ghost" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" aria-label="Next month" disabled={addMonths(month, 1) > new Date()} onClick={() => setMonth(addMonths(month, 1))}><ChevronRight className="h-4 w-4" /></Button>
      </>}>
        {recs.isLoading ? <PageLoader /> : (
          <>
            <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase text-slate-500">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-1">{d}</div>)}</div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: lead }).map((_, i) => <div key={`l${i}`} />)}
              {days.map((d) => {
                const k = format(d, 'yyyy-MM-dd');
                const r = byDate.get(k);
                const h = hByDate.get(k);
                const off = !working.includes(getISODay(d));
                return (
                  <div key={k} className={clsx('min-h-[64px] rounded-lg border p-1.5 text-left text-xs', off ? 'border-slate-100 bg-slate-50' : 'border-slate-200', format(new Date(), 'yyyy-MM-dd') === k && 'ring-2 ring-brand-500')}
                    title={r ? `${titleCase(r.status)}${r.check_in ? ` · ${fmtTime(r.check_in)}–${r.check_out ? fmtTime(r.check_out) : '…'}` : ''}` : h?.name}>
                    <span className="font-medium text-slate-700">{format(d, 'd')}</span>
                    {r && <span className="mt-1 flex items-center gap-1"><span className={clsx('h-2 w-2 rounded-full', DOT[r.status] ?? 'bg-slate-300')} /><span className="truncate">{titleCase(r.status)}</span></span>}
                    {!r && h && <span className="mt-1 block truncate text-cyan-700">{h.name}</span>}
                    {r?.work_minutes ? <span className="block text-slate-400">{(r.work_minutes / 60).toFixed(1)}h</span> : null}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-500">{Object.entries(DOT).map(([k, c]) => <span key={k} className="flex items-center gap-1"><span className={clsx('h-2 w-2 rounded-full', c)} />{titleCase(k)}</span>)}</div>
          </>
        )}
      </Card>
    </div>
  );
}

const markSchema = z.object({ status: z.string(), check_in: z.string().optional(), check_out: z.string().optional(), notes: z.string().max(500).optional() })
  .refine((v) => !v.check_in || !v.check_out || v.check_out > v.check_in, { message: 'Check-out must be after check-in', path: ['check_out'] });

function DailyRegister({ companyId }: { companyId: string }) {
  const { can } = useCompany();
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [dept, setDept] = useState('');
  const [search, setSearch] = useState('');
  const [marking, setMarking] = useState<{ e: Emp; r?: Rec } | null>(null);
  const [form, setForm] = useState({ status: 'present', check_in: '', check_out: '', notes: '' });
  const [err, setErr] = useState('');
  const depts = useDepartments();
  const emps = useList<Emp>({ table: 'v_employees', columns: 'id,full_name,employee_code,department_id,department_name', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'status', op: 'in', value: ['active', 'probation', 'notice'] }, ...(dept ? [{ column: 'department_id', op: 'eq' as const, value: dept }] : [])], order: [{ column: 'employee_code' }], range: [0, 1999], count: false });
  const recs = useList<Rec>({ table: 'attendance_records', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'attendance_date', op: 'eq', value: date }], range: [0, 4999], count: false });
  const mark = useAction(() => {
    const toTs = (t: string) => (t ? new Date(`${date}T${t}`).toISOString() : null);
    markSchema.parse(form);
    return api.db.rpc('upsert_attendance', { p_company: companyId, p_employee: marking!.e.id, p_date: date, p_status: form.status, p_check_in: toTs(form.check_in), p_check_out: toTs(form.check_out), p_notes: form.notes || null });
  }, { success: 'Attendance saved', onSuccess: () => setMarking(null), silent: true });
  const byEmp = useMemo(() => new Map((recs.data?.rows ?? []).map((r) => [r.employee_id, r])), [recs.data]);
  const list = (emps.data?.rows ?? []).filter((e) => !search || `${e.full_name} ${e.employee_code}`.toLowerCase().includes(search.toLowerCase()));
  const summary = useMemo(() => {
    const s: Record<string, number> = { present: 0, absent: 0, half_day: 0, on_leave: 0, unmarked: 0 };
    for (const e of emps.data?.rows ?? []) { const r = byEmp.get(e.id); s[r ? r.status : 'unmarked'] = (s[r ? r.status : 'unmarked'] ?? 0) + 1; }
    return s;
  }, [emps.data, byEmp]);
  const manage = can('attendance.manage');
  const open = (e: Emp, r?: Rec) => {
    setErr('');
    setForm({ status: r?.status ?? 'present', check_in: r?.check_in ? format(new Date(r.check_in), 'HH:mm') : '', check_out: r?.check_out ? format(new Date(r.check_out), 'HH:mm') : '', notes: r?.notes ?? '' });
    setMarking({ e, r });
  };
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Object.entries(summary).map(([k, v]) => <div key={k} className="card p-3"><p className="text-xs text-slate-500">{titleCase(k)}</p><p className="text-xl font-semibold">{v}</p></div>)}
      </div>
      <div className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row">
          <Input type="date" className="sm:w-44" value={date} max={format(new Date(), 'yyyy-MM-dd')} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          <Select className="sm:w-52" value={dept} onChange={(e) => setDept(e.target.value)} options={depts.options} placeholder="All departments" aria-label="Department" />
          <SearchInput className="sm:w-64" value={search} onChange={setSearch} placeholder="Search employee" />
          <div className="flex gap-1 sm:ml-auto">
            <Button size="sm" variant="ghost" aria-label="Previous day" onClick={() => setDate(format(addDays(new Date(date), -1), 'yyyy-MM-dd'))}><ChevronLeft className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" aria-label="Next day" disabled={date >= format(new Date(), 'yyyy-MM-dd')} onClick={() => setDate(format(addDays(new Date(date), 1), 'yyyy-MM-dd'))}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
        {emps.isLoading || recs.isLoading ? <PageLoader /> : emps.isError ? <ErrorState error={emps.error} /> : list.length === 0 ? <EmptyState title="No employees" /> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Employee</th><th className="hidden md:table-cell">Department</th><th>Status</th><th>In</th><th>Out</th><th className="hidden md:table-cell">Hours</th>{manage && <th />}</tr></thead>
              <tbody>
                {list.map((e) => {
                  const r = byEmp.get(e.id);
                  return (
                    <tr key={e.id}>
                      <td><div className="flex items-center gap-2"><Avatar name={e.full_name} size="xs" /><span className="font-medium">{e.full_name}</span><span className="text-xs text-slate-400">{e.employee_code}</span></div></td>
                      <td className="hidden md:table-cell">{e.department_name ?? '—'}</td>
                      <td>{r ? <StatusBadge kind="attendance" value={r.status} /> : <span className="text-xs text-slate-400">Not marked</span>}</td>
                      <td>{r?.check_in ? fmtTime(r.check_in) : '—'}</td><td>{r?.check_out ? fmtTime(r.check_out) : '—'}</td>
                      <td className="hidden md:table-cell">{r?.work_minutes ? (r.work_minutes / 60).toFixed(1) : '—'}</td>
                      {manage && <td className="text-right"><Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => open(e, r)}>{r ? 'Edit' : 'Mark'}</Button></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Modal open={!!marking} onClose={() => setMarking(null)} title={`Attendance · ${marking?.e.full_name ?? ''}`} description={fmtDate(date, 'EEEE, dd MMM yyyy')} size="sm"
        footer={<><Button variant="secondary" onClick={() => setMarking(null)}>Cancel</Button><Button loading={mark.isPending} onClick={() => mark.mutate(undefined, { onError: (e) => setErr(e instanceof z.ZodError ? e.errors[0].message : e.message) })}>Save</Button></>}>
        <div className="space-y-4">
          {err && <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
          <Field label="Status"><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} options={ATTENDANCE_STATUSES} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Check-in"><Input type="time" value={form.check_in} onChange={(e) => setForm({ ...form, check_in: e.target.value })} /></Field>
            <Field label="Check-out"><Input type="time" value={form.check_out} onChange={(e) => setForm({ ...form, check_out: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

function Records({ companyId }: { companyId: string }) {
  const depts = useDepartments();
  const table = useTable({ table: 'v_attendance', companyId, searchColumns: ['employee_name', 'employee_code'], defaultSort: { column: 'attendance_date', ascending: false }, filterOps: { attendance_date__from: 'gte', attendance_date__to: 'lte' } });
  const columns: Column<Rec>[] = [
    { key: 'attendance_date', header: 'Date', sortable: true, render: (r) => fmtDate(r.attendance_date, 'EEE, dd MMM yyyy') },
    { key: 'employee_name', header: 'Employee', sortable: true, render: (r) => <span><span className="font-medium">{r.employee_name}</span> <span className="text-xs text-slate-400">{r.employee_code}</span></span> },
    { key: 'department_name', header: 'Department', hideOnMobile: true, render: (r) => r.department_name ?? '—' },
    { key: 'status', header: 'Status', sortable: true, render: (r) => <StatusBadge kind="attendance" value={r.status} /> },
    { key: 'check_in', header: 'In', render: (r) => (r.check_in ? fmtTime(r.check_in) : '—') },
    { key: 'check_out', header: 'Out', render: (r) => (r.check_out ? fmtTime(r.check_out) : '—') },
    { key: 'work_minutes', header: 'Hours', sortable: true, hideOnMobile: true, render: (r) => (r.work_minutes ? (r.work_minutes / 60).toFixed(1) : '—'), csv: (r) => (r.work_minutes ? (r.work_minutes / 60).toFixed(2) : '') },
    { key: 'source', header: 'Source', hideOnMobile: true, render: (r) => titleCase(r.source) },
  ];
  return (
    <DataTable table={table} columns={columns} searchPlaceholder="Search employee" exportName="attendance"
      toolbar={<div className="flex items-center gap-2">
        <Input type="date" className="w-auto py-1.5" aria-label="From date" value={table.filters.attendance_date__from ?? ''} onChange={(e) => table.setFilter('attendance_date__from', e.target.value)} />
        <span className="text-slate-400">–</span>
        <Input type="date" className="w-auto py-1.5" aria-label="To date" value={table.filters.attendance_date__to ?? ''} onChange={(e) => table.setFilter('attendance_date__to', e.target.value)} />
      </div>}
      filters={[{ key: 'status', label: 'Status', options: ATTENDANCE_STATUSES }, { key: 'department_id', label: 'Departments', options: depts.options }]}
      empty={{ icon: <CalendarCheck className="h-6 w-6" />, title: 'No attendance records' }} />
  );
}

const holSchema = z.object({ name: reqStr(2, 80, 'Name'), holiday_date: reqDate('Date'), is_optional: z.boolean() });
function Holidays({ companyId }: { companyId: string }) {
  const { can } = useCompany();
  const [year, setYear] = useState(new Date().getFullYear());
  const q = useList<Holiday>({ table: 'holidays', filters: [{ column: 'company_id', op: 'eq', value: companyId }, { column: 'holiday_date', op: 'gte', value: `${year}-01-01` }, { column: 'holiday_date', op: 'lte', value: `${year}-12-31` }], order: [{ column: 'holiday_date' }], range: [0, 199] });
  const [editing, setEditing] = useState<Holiday | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Holiday | null>(null);
  const save = useAction((v: z.infer<typeof holSchema>) => (editing === 'new' ? api.db.insert('holidays', { ...v, company_id: companyId }) : api.db.update('holidays', (editing as Holiday).id, v)), { success: 'Holiday saved' });
  const remove = useAction((id: string) => api.db.remove('holidays', id), { success: 'Holiday deleted', onSuccess: () => setDeleting(null) });
  const manage = can('attendance.manage');
  const fields: FieldDef<z.infer<typeof holSchema>>[] = [{ name: 'name', label: 'Holiday name', required: true, span: 2 }, { name: 'holiday_date', label: 'Date', type: 'date', required: true }, { name: 'is_optional', label: 'Optional (restricted) holiday', type: 'checkbox' }];
  return (
    <Card title={`Holiday calendar ${year}`} padded={false} actions={<>
      <Button size="sm" variant="ghost" aria-label="Previous year" onClick={() => setYear(year - 1)}><ChevronLeft className="h-4 w-4" /></Button>
      <Button size="sm" variant="ghost" aria-label="Next year" onClick={() => setYear(year + 1)}><ChevronRight className="h-4 w-4" /></Button>
      {manage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Add holiday</Button>}
    </>}>
      {q.isLoading ? <PageLoader /> : (q.data?.rows ?? []).length === 0 ? <EmptyState title={`No holidays for ${year}`} /> : (
        <ul className="divide-y divide-slate-100">
          {q.data!.rows.map((h) => (
            <li key={h.id} className="flex items-center gap-4 px-5 py-3">
              <div className="w-14 rounded-lg bg-brand-50 py-1 text-center"><p className="text-[10px] font-semibold uppercase text-brand-600">{format(new Date(h.holiday_date), 'MMM')}</p><p className="text-lg font-bold leading-tight text-brand-700">{format(new Date(h.holiday_date), 'd')}</p></div>
              <div className="flex-1"><p className="font-medium">{h.name}</p><p className="text-xs text-slate-500">{format(new Date(h.holiday_date), 'EEEE')}{h.is_optional ? ' · Optional' : ''}</p></div>
              {manage && <><Button size="sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(h)}><Pencil className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label="Delete" onClick={() => setDeleting(h)}><Trash2 className="h-4 w-4 text-rose-500" /></Button></>}
            </li>
          ))}
        </ul>
      )}
      <FormModal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add holiday' : 'Edit holiday'} size="sm" schema={holSchema} fields={fields}
        defaultValues={(editing && editing !== 'new' ? editing : { is_optional: false, holiday_date: `${year}-01-01` }) as never} onSubmit={(v) => save.mutateAsync(v)} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete holiday?" tone="danger" confirmLabel="Delete" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </Card>
  );
}

export function Attendance() {
  const { companyId, can } = useCompany();
  const me = useRpc<{ employee: { id: string } | null }>('my_dashboard', companyId ? { p_company: companyId } : null);
  const employeeId = me.data?.employee?.id;
  const tabs = [
    ...(employeeId ? [{ value: 'mine' as const, label: 'My attendance' }] : []),
    ...(can('attendance.view') ? [{ value: 'register' as const, label: 'Daily register' }, { value: 'records' as const, label: 'All records' }] : []),
    { value: 'holidays' as const, label: 'Holidays' },
  ];
  const [tab, setTab] = useState<'mine' | 'register' | 'records' | 'holidays' | null>(null);
  if (me.isLoading || !companyId) return <PageLoader />;
  const active = tab ?? tabs[0].value;
  return (
    <>
      <PageHeader title="Attendance" description="Clock in and out, review attendance and manage the holiday calendar." />
      <Tabs className="mb-5" value={active} onChange={setTab} tabs={tabs} />
      {active === 'mine' && employeeId && <MyAttendance companyId={companyId} employeeId={employeeId} />}
      {active === 'register' && <DailyRegister companyId={companyId} />}
      {active === 'records' && <Records companyId={companyId} />}
      {active === 'holidays' && <Holidays companyId={companyId} />}
    </>
  );
}
