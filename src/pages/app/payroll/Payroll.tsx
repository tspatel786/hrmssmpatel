import { ArrowLeft, CheckCircle2, Download, FileText, Play, RefreshCw, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, Modal, PageHeader, PageLoader, Select, StatCard } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { MONTHS } from '@/lib/constants';
import { downloadBlob } from '@/lib/csv';
import { fmtDateTime, fmtMoney, monthName } from '@/lib/format';
import { useAction, useList, useRpc, useTable } from '@/lib/hooks';
import { generatePayslipPdf, type PayslipPdfData } from '@/lib/pdf';

interface Run { id: string; period_year: number; period_month: number; status: string; working_days: number; employee_count: number; total_gross: number; total_deductions: number; total_net: number; processed_at: string | null; paid_at: string | null; created_at: string }
type Slip = PayslipPdfData & { id: string; employee_id: string; payroll_run_id: string; run_status: string; employee_email: string };

export function Payroll() {
  const { companyId, company, can } = useCompany();
  const navigate = useNavigate();
  const [running, setRunning] = useState(false);
  const last = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
  const [period, setPeriod] = useState({ year: String(last.getFullYear()), month: String(last.getMonth() + 1) });
  const table = useTable({ table: 'payroll_runs', companyId, defaultSort: { column: 'period_year', ascending: false }, thenBy: [{ column: 'period_month', ascending: false }] });
  const run = useAction(() => api.db.rpc<string>('generate_payroll', { p_company: companyId, p_year: Number(period.year), p_month: Number(period.month) }), {
    success: 'Payroll generated as draft — review before processing', onSuccess: (id) => navigate(`/app/payroll/${id}`),
  });
  const rows = table.rows as Run[];
  const latest = rows[0];
  const cur = company?.currency;
  const columns: Column<Run>[] = [
    { key: 'period', header: 'Period', render: (r) => <span className="font-medium text-slate-900">{monthName(r.period_month)} {r.period_year}</span>, csv: (r) => `${r.period_year}-${String(r.period_month).padStart(2, '0')}` },
    { key: 'employee_count', header: 'Employees' },
    { key: 'total_gross', header: 'Gross', render: (r) => fmtMoney(r.total_gross, cur) },
    { key: 'total_deductions', header: 'Deductions', hideOnMobile: true, render: (r) => fmtMoney(r.total_deductions, cur) },
    { key: 'total_net', header: 'Net pay', render: (r) => <span className="font-semibold">{fmtMoney(r.total_net, cur)}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge kind="payroll" value={r.status} /> },
    { key: 'processed_at', header: 'Processed', hideOnMobile: true, render: (r) => fmtDateTime(r.processed_at) },
  ];
  const years = [0, 1, 2].map((d) => String(new Date().getFullYear() - d));
  return (
    <>
      <PageHeader title="Payroll" description="Monthly payroll runs computed from salary structures, attendance and unpaid leave."
        actions={can('payroll.manage') && <Button icon={<Play className="h-4 w-4" />} onClick={() => setRunning(true)}>Run payroll</Button>} />
      {latest && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Latest period" value={`${monthName(latest.period_month)} ${latest.period_year}`} icon={<Wallet className="h-5 w-5" />} hint={latest.status} />
          <StatCard label="Net pay" value={fmtMoney(latest.total_net, cur, true)} tone="green" />
          <StatCard label="Gross" value={fmtMoney(latest.total_gross, cur, true)} tone="violet" />
          <StatCard label="Employees paid" value={latest.employee_count} tone="cyan" />
        </div>
      )}
      <DataTable table={table} columns={columns} exportName="payroll-runs" onRowClick={(r) => navigate(`/app/payroll/${r.id}`)}
        empty={{ icon: <Wallet className="h-6 w-6" />, title: 'No payroll runs yet', description: 'Run payroll for a month to generate payslips.', action: can('payroll.manage') && <Button size="sm" onClick={() => setRunning(true)}>Run payroll</Button> }} />
      <Modal open={running} onClose={() => setRunning(false)} title="Run payroll" size="sm"
        footer={<><Button variant="secondary" onClick={() => setRunning(false)}>Cancel</Button><Button loading={run.isPending} onClick={() => run.mutate()}>Generate</Button></>}>
        <p className="text-sm text-slate-600">Payslips are calculated for all active employees with a salary structure. Loss-of-pay is applied for unpaid leave and absences. Existing draft runs for the period are recalculated.</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="Month"><Select value={period.month} onChange={(e) => setPeriod({ ...period, month: e.target.value })} options={MONTHS} /></Field>
          <Field label="Year"><Select value={period.year} onChange={(e) => setPeriod({ ...period, year: e.target.value })} options={years.map((y) => ({ value: y, label: y }))} /></Field>
        </div>
      </Modal>
    </>
  );
}

function slipPdf(s: Slip, company: PayslipPdfData['company']) {
  downloadBlob(`Payslip-${s.employee_code}-${s.period_year}-${String(s.period_month).padStart(2, '0')}.pdf`, generatePayslipPdf({ ...s, company }));
}

export function PayrollRun() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { company, can } = useCompany();
  const q = useList<Run>({ table: 'payroll_runs', filters: [{ column: 'id', op: 'eq', value: id }], count: false });
  const table = useTable({ table: 'v_payslips', baseFilters: [{ column: 'payroll_run_id', op: 'eq', value: id }], searchColumns: ['employee_name', 'employee_code'], defaultSort: { column: 'employee_code' }, pageSize: 50 });
  const [confirm, setConfirm] = useState<'finalize' | 'paid' | 'delete' | null>(null);
  const r = q.data?.rows[0];
  const regen = useAction(() => api.db.rpc('generate_payroll', { p_company: company!.id, p_year: r!.period_year, p_month: r!.period_month }), { success: 'Payroll recalculated' });
  const finalize = useAction(() => api.db.rpc('finalize_payroll', { p_run: id }), { success: 'Payroll processed · payslips released to employees', onSuccess: () => setConfirm(null) });
  const paid = useAction(() => api.db.rpc('mark_payroll_paid', { p_run: id }), { success: 'Marked as paid', onSuccess: () => setConfirm(null) });
  const remove = useAction(() => api.db.remove('payroll_runs', id), { success: 'Draft run deleted', onSuccess: () => navigate('/app/payroll') });
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!r) return <ErrorState error="Payroll run not found." />;
  const cur = company?.currency;
  const manage = can('payroll.manage');
  const columns: Column<Slip>[] = [
    { key: 'employee_name', header: 'Employee', sortable: true, render: (s) => <span><span className="font-medium">{s.employee_name}</span><span className="block text-xs text-slate-500">{s.employee_code} · {s.designation_title ?? '—'}</span></span> },
    { key: 'employee_code', header: 'Code', className: 'hidden' },
    { key: 'paid_days', header: 'Paid days', render: (s) => <span>{s.paid_days}/{s.working_days}{s.lop_days > 0 && <span className="ml-1 text-xs text-rose-600">({s.lop_days} LOP)</span>}</span>, csv: (s) => s.paid_days },
    { key: 'lop_days', header: 'LOP', className: 'hidden' },
    { key: 'basic', header: 'Basic', className: 'hidden' }, { key: 'hra', header: 'HRA', className: 'hidden' }, { key: 'allowances', header: 'Allowances', className: 'hidden' },
    { key: 'gross', header: 'Gross', sortable: true, render: (s) => fmtMoney(s.gross, cur) },
    { key: 'pf', header: 'PF', className: 'hidden' }, { key: 'professional_tax', header: 'Prof. tax', className: 'hidden' }, { key: 'tds', header: 'TDS', className: 'hidden' }, { key: 'other_deductions', header: 'Other ded.', className: 'hidden' },
    { key: 'total_deductions', header: 'Deductions', hideOnMobile: true, render: (s) => fmtMoney(s.total_deductions, cur) },
    { key: 'net_pay', header: 'Net pay', sortable: true, render: (s) => <span className="font-semibold">{fmtMoney(s.net_pay, cur)}</span> },
  ];
  return (
    <>
      <PageHeader breadcrumb={<Link to="/app/payroll" className="inline-flex items-center gap-1 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Payroll</Link>}
        title={<span className="flex items-center gap-3">{monthName(r.period_month)} {r.period_year} <StatusBadge kind="payroll" value={r.status} /></span>}
        description={`${r.working_days} working days · ${r.employee_count} employees`}
        actions={manage && <>
          {r.status === 'draft' && <>
            <Button variant="ghost" aria-label="Delete draft" onClick={() => setConfirm('delete')}><Trash2 className="h-4 w-4 text-rose-500" /></Button>
            <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={regen.isPending} onClick={() => regen.mutate()}>Recalculate</Button>
            <Button icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setConfirm('finalize')} disabled={r.employee_count === 0}>Process payroll</Button>
          </>}
          {r.status === 'processed' && <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setConfirm('paid')}>Mark as paid</Button>}
        </>} />
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard label="Total gross" value={fmtMoney(r.total_gross, cur)} tone="violet" />
        <StatCard label="Total deductions" value={fmtMoney(r.total_deductions, cur)} tone="rose" />
        <StatCard label="Total net pay" value={fmtMoney(r.total_net, cur)} tone="green" />
      </div>
      <DataTable table={table} columns={columns.filter((c) => c.className !== 'hidden')} searchPlaceholder="Search employee" exportName={`payroll-register-${r.period_year}-${r.period_month}`}
        rowActions={(s) => <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => slipPdf(s, company!)}>Payslip</Button>}
        empty={{ title: 'No payslips', description: 'No active employees with a salary structure for this period.' }} />
      <p className="mt-2 text-xs text-slate-500">CSV export includes the visible columns; download individual payslips for the full breakup.</p>
      <ConfirmDialog open={confirm === 'finalize'} onClose={() => setConfirm(null)} loading={finalize.isPending} tone="primary" confirmLabel="Process payroll"
        title="Process payroll?" message="Payslips will be locked and released to employees, who will be notified by email." onConfirm={() => finalize.mutate()} />
      <ConfirmDialog open={confirm === 'paid'} onClose={() => setConfirm(null)} loading={paid.isPending} tone="success" confirmLabel="Mark paid" title="Mark payroll as paid?" onConfirm={() => paid.mutate()} />
      <ConfirmDialog open={confirm === 'delete'} onClose={() => setConfirm(null)} loading={remove.isPending} tone="danger" confirmLabel="Delete" title="Delete draft payroll run?" onConfirm={() => remove.mutate()} />
    </>
  );
}

export function MyPayslips() {
  const { companyId, company } = useCompany();
  const me = useRpc<{ employee: { id: string } | null }>('my_dashboard', companyId ? { p_company: companyId } : null);
  const empId = me.data?.employee?.id;
  // filter by own employee id: payroll viewers can read everyone's payslips through RLS
  const q = useList<Slip>(empId ? { table: 'v_payslips', filters: [{ column: 'employee_id', op: 'eq', value: empId }], order: [{ column: 'period_year', ascending: false }, { column: 'period_month', ascending: false }], range: [0, 59] } : null);
  const cur = company?.currency;
  if (me.isLoading || (empId && q.isLoading)) return <PageLoader />;
  if (me.isError || q.isError) return <ErrorState error={me.error ?? q.error} onRetry={() => { void me.refetch(); void q.refetch(); }} />;
  const rows = q.data?.rows ?? [];
  return (
    <>
      <PageHeader title="My payslips" description="Download your monthly payslips." />
      {!empId ? <div className="card"><EmptyState title="No employee profile" description="Your account is not linked to an employee profile." /></div>
        : rows.length === 0 ? <div className="card"><EmptyState icon={<FileText className="h-6 w-6" />} title="No payslips yet" description="Payslips appear here once payroll is processed." /></div> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((s) => (
              <div key={s.id} className="card p-5">
                <div className="flex items-start justify-between"><div><p className="text-sm text-slate-500">{s.period_year}</p><p className="text-lg font-semibold">{monthName(s.period_month)}</p></div><StatusBadge kind="payroll" value={s.run_status} /></div>
                <p className="mt-4 text-xs text-slate-500">Net pay</p><p className="text-2xl font-semibold">{fmtMoney(s.net_pay, cur)}</p>
                <p className="mt-1 text-xs text-slate-500">Gross {fmtMoney(s.gross, cur)} · Deductions {fmtMoney(s.total_deductions, cur)} · {s.paid_days}/{s.working_days} days</p>
                <Button className="mt-4 w-full" variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => company && slipPdf(s, company)}>Download PDF</Button>
              </div>
            ))}
          </div>
        )}
    </>
  );
}
