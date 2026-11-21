import { format, startOfMonth } from 'date-fns';
import clsx from 'clsx';
import { BarChart3, Briefcase, CalendarCheck, Download, FileDown, FileSignature, Plane, Printer, Users, Wallet } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, PageLoader, Select } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { downloadBlob, downloadCsv } from '@/lib/csv';
import { fmtDate, fmtMoney, fmtMoneyPlain, monthName, titleCase } from '@/lib/format';
import { generateReportPdf } from '@/lib/pdf';
import { fetchAll, useList } from '@/lib/hooks';

type Row = Record<string, unknown>;
interface ReportDef {
  key: string;
  title: string;
  description: string;
  icon: ReactNode;
  params: ('range' | 'year' | 'run')[];
  money?: string[];
  run: (companyId: string, p: Params) => Promise<Row[]>;
}
interface Params { from: string; to: string; year: string; run: string }

const REPORTS: ReportDef[] = [
  { key: 'headcount', title: 'Headcount by department', description: 'Active, probation, notice and exited employees with monthly cost.', icon: <Users className="h-5 w-5" />, params: [], money: ['monthly_cost'],
    run: (c) => api.db.rpc<Row[]>('report_headcount', { p_company: c }) },
  { key: 'directory', title: 'Employee directory', description: 'Complete employee list with job details.', icon: <Users className="h-5 w-5" />, params: [],
    run: (c) => fetchAll<Row>({ table: 'v_employees', columns: 'employee_code,full_name,email,phone,department_name,designation_title,manager_name,employment_type,joining_date,status,work_location', filters: [{ column: 'company_id', op: 'eq', value: c }], order: [{ column: 'employee_code' }] }) },
  { key: 'attendance', title: 'Attendance summary', description: 'Present, absent, half-day and leave days with hours per employee.', icon: <CalendarCheck className="h-5 w-5" />, params: ['range'],
    run: (c, p) => api.db.rpc<Row[]>('report_attendance', { p_company: c, p_from: p.from, p_to: p.to }) },
  { key: 'leave', title: 'Leave summary', description: 'Allocated, used, pending and available leave by type.', icon: <Plane className="h-5 w-5" />, params: ['year'],
    run: (c, p) => api.db.rpc<Row[]>('report_leave', { p_company: c, p_year: Number(p.year) }) },
  { key: 'recruitment', title: 'Recruitment funnel', description: 'Applications, shortlists, interviews, offers and hires per job.', icon: <Briefcase className="h-5 w-5" />, params: ['range'],
    run: (c, p) => api.db.rpc<Row[]>('report_recruitment', { p_company: c, p_from: p.from, p_to: p.to }) },
  { key: 'offers', title: 'Offers report', description: 'All offers with status, CTC and response dates.', icon: <FileSignature className="h-5 w-5" />, params: ['range'], money: ['ctc_annual'],
    run: (c, p) => fetchAll<Row>({ table: 'v_offers', columns: 'offer_number,candidate_name,job_title,department_name,ctc_annual,joining_date,status,sent_at,responded_at', filters: [{ column: 'company_id', op: 'eq', value: c }, { column: 'created_at', op: 'gte', value: p.from }, { column: 'created_at', op: 'lte', value: `${p.to}T23:59:59` }], order: [{ column: 'created_at', ascending: false }] }) },
  { key: 'payroll', title: 'Payroll register', description: 'Earnings and deductions for every employee in a payroll run.', icon: <Wallet className="h-5 w-5" />, params: ['run'], money: ['basic', 'hra', 'allowances', 'gross', 'pf', 'professional_tax', 'tds', 'other_deductions', 'total_deductions', 'net_pay'],
    run: (_c, p) => (p.run ? fetchAll<Row>({ table: 'v_payslips', columns: 'employee_code,employee_name,department_name,working_days,paid_days,lop_days,basic,hra,allowances,gross,pf,professional_tax,tds,other_deductions,total_deductions,net_pay', filters: [{ column: 'payroll_run_id', op: 'eq', value: p.run }], order: [{ column: 'employee_code' }] }) : Promise.resolve([])) },
];

export function Reports() {
  const { companyId, company, can } = useCompany();
  const [active, setActive] = useState<ReportDef>(REPORTS[0]);
  const [params, setParams] = useState<Params>({ from: format(startOfMonth(new Date()), 'yyyy-MM-dd'), to: format(new Date(), 'yyyy-MM-dd'), year: String(new Date().getFullYear()), run: '' });
  const [applied, setApplied] = useState(params);
  const runs = useList<{ id: string; period_year: number; period_month: number; status: string }>(can('payroll.view') && companyId ? { table: 'payroll_runs', filters: [{ column: 'company_id', op: 'eq', value: companyId }], order: [{ column: 'period_year', ascending: false }, { column: 'period_month', ascending: false }], range: [0, 59], count: false } : null);
  const q = useQuery({ queryKey: ['report', active.key, companyId, applied], queryFn: () => active.run(companyId!, applied), enabled: !!companyId && !(active.params.includes('run') && !applied.run) });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const cols = useMemo(() => (rows[0] ? Object.keys(rows[0]) : []), [rows]);
  const fmt = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return '—';
    if (active.money?.includes(k)) return fmtMoney(Number(v), company?.currency);
    if (/_date$|_at$/.test(k) && typeof v === 'string') return fmtDate(v);
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'string' && /^[a-z]+(_[a-z]+)*$/.test(v) && ['status', 'employment_type'].includes(k)) return titleCase(v);
    return String(v);
  };
  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const k of cols) if (rows.every((r) => typeof r[k] === 'number')) t[k] = rows.reduce((a, r) => a + Number(r[k]), 0);
    return t;
  }, [rows, cols]);
  const visible = REPORTS.filter((r) => r.key !== 'payroll' || can('payroll.view'));
  const exportCsv = () => {
    downloadCsv(`${active.key}-report-${format(new Date(), 'yyyy-MM-dd')}.csv`, cols.map(titleCase), rows.map((r) => cols.map((c) => r[c])));
    toast.success(`Exported ${rows.length} rows`);
  };

  const exportPdf = () => {
    // PDF fonts have no rupee glyph: money uses the plain "INR 1,23,456" form
    const cell = (k: string, v: unknown) => (active.money?.includes(k) && v != null && v !== '' ? fmtMoneyPlain(Number(v), company?.currency ?? 'INR') : fmt(k, v));
    const summable = (c: string) => c in totals && !/days$|_pct$|avg_/.test(c);
    const subtitle = active.params.includes('range') ? `${fmtDate(applied.from)} – ${fmtDate(applied.to)}` : active.params.includes('year') ? `Year ${applied.year}`
      : active.params.includes('run') ? (runs.data?.rows ?? []).filter((r) => r.id === applied.run).map((r) => `${monthName(r.period_month)} ${r.period_year}`)[0] : undefined;
    const blob = generateReportPdf({
      title: active.title, subtitle, columns: cols.map(titleCase), rows: rows.map((r) => cols.map((c) => cell(c, r[c]))),
      numeric: cols.map((c) => rows.every((r) => typeof r[c] === 'number' || r[c] == null)),
      totals: Object.keys(totals).length > 0 && rows.length > 1 ? cols.map((c, i) => (i === 0 ? 'Total' : summable(c) ? cell(c, Math.round(totals[c] * 100) / 100) : '')) : null,
      company: { ...(company ?? { name: 'Company' }), name: company?.name ?? 'Company' },
    });
    downloadBlob(`${active.key}-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`, blob);
    toast.success('PDF downloaded');
  };

  return (
    <>
      <PageHeader title="Reports" description="Operational reports with CSV and PDF export and print." />
      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <nav className="no-print space-y-1" aria-label="Reports">
          {visible.map((r) => (
            <button key={r.key} type="button" onClick={() => setActive(r)}
              className={clsx('flex w-full items-start gap-3 rounded-xl border p-3 text-left transition', active.key === r.key ? 'border-brand-300 bg-brand-50' : 'border-transparent hover:bg-white')}>
              <span className={clsx('mt-0.5 rounded-lg p-1.5', active.key === r.key ? 'bg-brand-500 text-ink' : 'bg-slate-100 text-slate-500')}>{r.icon}</span>
              <span><span className="block text-sm font-semibold text-slate-900">{r.title}</span><span className="block text-xs text-slate-500">{r.description}</span></span>
            </button>
          ))}
        </nav>
        <Card title={active.title} padded={false} actions={<div className="no-print flex gap-2">
          <Button size="sm" variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()} disabled={!rows.length}>Print</Button>
          <Button size="sm" variant="secondary" icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!rows.length}>Export CSV</Button>
          <Button size="sm" variant="secondary" icon={<FileDown className="h-4 w-4" />} onClick={exportPdf} disabled={!rows.length}>Export PDF</Button>
        </div>}>
          {active.params.length > 0 && (
            <form className="no-print flex flex-wrap items-end gap-3 border-b border-slate-100 p-4" onSubmit={(e) => { e.preventDefault(); if (params.from > params.to) { toast.error('From date must be before To date'); return; } setApplied(params); }}>
              {active.params.includes('range') && <>
                <Field label="From"><Input type="date" value={params.from} onChange={(e) => setParams({ ...params, from: e.target.value })} /></Field>
                <Field label="To"><Input type="date" value={params.to} onChange={(e) => setParams({ ...params, to: e.target.value })} /></Field>
              </>}
              {active.params.includes('year') && <Field label="Year"><Select value={params.year} onChange={(e) => setParams({ ...params, year: e.target.value })} options={[0, 1, 2].map((d) => String(new Date().getFullYear() - d)).map((y) => ({ value: y, label: y }))} /></Field>}
              {active.params.includes('run') && <Field label="Payroll run"><Select value={params.run} onChange={(e) => setParams({ ...params, run: e.target.value })} placeholder="Select a run"
                options={(runs.data?.rows ?? []).map((r) => ({ value: r.id, label: `${monthName(r.period_month)} ${r.period_year} (${r.status})` }))} /></Field>}
              <Button type="submit">Run report</Button>
            </form>
          )}
          {q.isLoading ? <PageLoader label="Running report…" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? (
            <EmptyState icon={<BarChart3 className="h-6 w-6" />} title={active.params.includes('run') && !applied.run ? 'Select a payroll run' : 'No data for the selected parameters'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr>{cols.map((c) => <th key={c}>{titleCase(c)}</th>)}</tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'text-right tabular-nums' : ''}>{fmt(c, r[c])}</td>)}</tr>)}</tbody>
                {Object.keys(totals).length > 0 && rows.length > 1 && (
                  <tfoot><tr className="bg-slate-50 font-semibold">{cols.map((c, i) => <td key={c} className="px-4 py-2.5 text-right tabular-nums">{i === 0 ? <span className="float-left">Total</span> : c in totals && !/days$|_pct$|avg_/.test(c) ? fmt(c, Math.round(totals[c] * 100) / 100) : ''}</td>)}</tr></tfoot>
                )}
              </table>
              <p className="px-4 py-3 text-xs text-slate-500">{rows.length} rows · generated {format(new Date(), 'dd MMM yyyy, hh:mm a')}</p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
