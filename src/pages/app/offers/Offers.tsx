import { FileSignature } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable, StatusBadge, type Column } from '@/components/DataTable';
import { PageHeader, StatCard, Tabs } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { opts } from '@/lib/constants';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useList, useTable } from '@/lib/hooks';
import type { Offer } from './OfferForm';
import { OfferTemplates } from './OfferTemplates';

export function Offers() {
  const { companyId, company } = useCompany();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'templates' ? 'templates' : 'offers';
  const table = useTable({ table: 'v_offers', companyId, searchColumns: ['candidate_name', 'job_title', 'offer_number', 'candidate_email'], defaultSort: { column: 'created_at', ascending: false } });
  const counts = useList<{ status: string }>(companyId ? { table: 'offers', columns: 'status', filters: [{ column: 'company_id', op: 'eq', value: companyId }], range: [0, 4999], count: false } : null);
  const n = (s: string[]) => (counts.data?.rows ?? []).filter((r) => s.includes(r.status)).length;
  const columns: Column<Offer>[] = [
    { key: 'candidate_name', header: 'Candidate', sortable: true, render: (o) => <div><p className="font-medium text-slate-900">{o.candidate_name}</p><p className="text-xs text-slate-500">{o.offer_number}</p></div> },
    { key: 'job_title', header: 'Role', sortable: true, render: (o) => <span>{o.designation_title ?? o.job_title}<span className="block text-xs text-slate-500">{o.department_name}</span></span> },
    { key: 'ctc_annual', header: 'CTC', sortable: true, render: (o) => fmtMoney(o.ctc_annual, company?.currency) },
    { key: 'joining_date', header: 'Joining', sortable: true, hideOnMobile: true, render: (o) => fmtDate(o.joining_date) },
    { key: 'expiry_date', header: 'Expires', hideOnMobile: true, render: (o) => fmtDate(o.expiry_date) },
    { key: 'status', header: 'Status', sortable: true, render: (o) => <StatusBadge kind="offer" value={o.status} /> },
  ];
  return (
    <>
      <PageHeader title="Offers" description="Draft, approve and send offer letters. Candidates accept securely online — no account required." />
      <Tabs className="mb-5" value={tab} onChange={(t) => setParams(t === 'offers' ? {} : { tab: t }, { replace: true })} tabs={[{ value: 'offers', label: 'Offers' }, { value: 'templates', label: 'Letter templates' }]} />
      {tab === 'templates' ? <OfferTemplates /> : <>
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Awaiting approval" value={n(['pending_approval'])} tone="amber" />
        <StatCard label="Ready to send" value={n(['approved'])} tone="blue" />
        <StatCard label="Sent · awaiting response" value={n(['sent'])} tone="violet" />
        <StatCard label="Accepted" value={n(['accepted'])} tone="green" />
      </div>
      <DataTable table={table} columns={columns} searchPlaceholder="Search candidate, role, offer #" exportName="offers" onRowClick={(o) => navigate(`/app/offers/${o.id}`)}
        filters={[{ key: 'status', label: 'Status', options: opts(['draft', 'pending_approval', 'approved', 'rejected', 'sent', 'accepted', 'declined', 'expired', 'withdrawn']) }]}
        mobileCard={(o) => <div className="flex items-start justify-between gap-2"><div><p className="font-medium">{o.candidate_name}</p><p className="text-xs text-slate-500">{o.job_title} · {fmtMoney(o.ctc_annual, company?.currency)}</p></div><StatusBadge kind="offer" value={o.status} /></div>}
        empty={{ icon: <FileSignature className="h-6 w-6" />, title: 'No offers yet', description: 'Select a candidate after interviews, then create an offer from their profile.' }} />
      </>}
    </>
  );
}
