// Offer-letter templates: title, introduction, general terms and closing with {{placeholders}}.
// Compensation and joining tables are always generated from the offer itself.
import { Copy, FileText, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { FormModal, type FieldDef } from '@/components/FormModal';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, PageLoader } from '@/components/ui';
import { useCompany } from '@/contexts/session';
import { api } from '@/lib/backend';
import { useAction, useList } from '@/lib/hooks';
import { generateOfferPdf, OFFER_PLACEHOLDERS } from '@/lib/pdf';
import { reqStr } from '@/lib/schemas';

export interface OfferTemplate { id: string; name: string; title: string; intro: string; general_terms: string; closing: string; is_default: boolean; is_active: boolean }

export function useOfferTemplates(activeOnly = true) {
  const { companyId } = useCompany();
  return useList<OfferTemplate>(companyId ? { table: 'offer_templates', filters: [{ column: 'company_id', op: 'eq', value: companyId }, ...(activeOnly ? [{ column: 'is_active', op: 'eq' as const, value: true }] : [])],
    order: [{ column: 'is_default', ascending: false }, { column: 'name' }], range: [0, 99], count: false } : null);
}

const schema = z.object({
  name: reqStr(2, 80, 'Name'),
  title: reqStr(3, 80, 'Letter title'),
  intro: reqStr(10, 4000, 'Introduction'),
  general_terms: reqStr(10, 8000, 'General terms'),
  closing: reqStr(10, 2000, 'Closing'),
  is_default: z.boolean(),
  is_active: z.boolean(),
});
type Values = z.infer<typeof schema>;

export function OfferTemplates() {
  const { companyId, company, can } = useCompany();
  const q = useOfferTemplates(false);
  const manage = can('offers.manage');
  const [editing, setEditing] = useState<OfferTemplate | 'new' | null>(null);
  const [copyOf, setCopyOf] = useState<OfferTemplate | null>(null);
  const [deleting, setDeleting] = useState<OfferTemplate | null>(null);
  const save = useAction((v: Values) => (editing && editing !== 'new' ? api.db.update('offer_templates', editing.id, v) : api.db.insert('offer_templates', { ...v, company_id: companyId })),
    { success: 'Template saved', onSuccess: () => { setEditing(null); setCopyOf(null); } });
  const remove = useAction((id: string) => api.db.remove('offer_templates', id), { success: 'Template deleted', onSuccess: () => setDeleting(null) });
  const makeDefault = useAction((id: string) => api.db.update('offer_templates', id, { is_default: true }), { success: 'Default template updated' });

  const preview = (t: OfferTemplate) => {
    const blob = generateOfferPdf({ offer_number: 'OFR-SAMPLE', candidate_name: 'Alex Sample', job_title: 'Software Engineer', designation: 'Software Engineer II', department: 'Engineering',
      reporting_manager: 'Jordan Lead', employment_type: 'full_time', work_location: company?.city ?? 'Head office', ctc_annual: 1800000, basic_monthly: 60000, hra_monthly: 30000,
      allowances_monthly: 52500, joining_date: new Date(Date.now() + 30 * 86400000).toISOString(), expiry_date: new Date(Date.now() + 7 * 86400000).toISOString(), probation_months: 6,
      company: { ...(company ?? { name: 'Company' }), name: company?.name ?? 'Company' }, template: t });
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  };

  const fields: FieldDef<Values>[] = [
    { name: 'name', label: 'Template name', required: true, hint: 'Internal, e.g. "Sales with incentives"' },
    { name: 'title', label: 'Letter title', required: true, hint: 'Printed in the header, e.g. "Offer of Employment"' },
    { name: 'intro', label: 'Introduction', type: 'textarea', rows: 4, required: true, span: 2 },
    { name: 'general_terms', label: 'General terms', type: 'textarea', rows: 5, required: true, span: 2 },
    { name: 'closing', label: 'Closing / acceptance', type: 'textarea', rows: 3, required: true, span: 2 },
    { name: 'is_default', label: 'Default for new offers', type: 'checkbox' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
  ];
  const initial = editing && editing !== 'new' ? editing : copyOf ? { ...copyOf, name: `${copyOf.name} (copy)`, is_default: false, is_active: true }
    : { title: 'Offer of Employment', is_default: false, is_active: true, intro: 'We are delighted to offer you the position of {{role}}{{department_clause}} at {{company_name}}.', general_terms: '', closing: 'Please confirm your acceptance by {{expiry_date}} using the secure link shared with you by email.' };

  return (
    <Card title="Offer letter templates" padded={false} actions={manage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => { setCopyOf(null); setEditing('new'); }}>New template</Button>}>
      <p className="px-5 pt-4 text-sm text-slate-500">
        The position, compensation and signature sections are generated from each offer. Templates control the letter title and wording.
        Placeholders: {OFFER_PLACEHOLDERS.map((p) => <code key={p} className="mx-0.5 rounded bg-slate-100 px-1 text-xs">{`{{${p}}}`}</code>)}
      </p>
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} /> : (q.data?.rows ?? []).length === 0 ? <EmptyState icon={<FileText className="h-6 w-6" />} title="No templates yet" description="Offers use the standard letter until you add a template." /> : (
        <ul className="divide-y divide-slate-100" data-testid="offer-templates">
          {q.data!.rows.map((t) => (
            <li key={t.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">{t.name}{t.is_default && <Badge tone="blue">Default</Badge>}{!t.is_active && <Badge>Inactive</Badge>}</p>
                <p className="truncate text-xs text-slate-500">{t.title} · {t.intro}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1">
                <Button size="sm" variant="ghost" onClick={() => preview(t)}>Preview PDF</Button>
                {manage && <>
                  {!t.is_default && t.is_active && <Button size="sm" variant="ghost" icon={<Star className="h-4 w-4" />} onClick={() => makeDefault.mutate(t.id)}>Make default</Button>}
                  <Button size="sm" variant="ghost" aria-label={`Duplicate ${t.name}`} onClick={() => { setEditing('new'); setCopyOf(t); }}><Copy className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => { setCopyOf(null); setEditing(t); }}><Pencil className="h-4 w-4" /></Button>
                  {!t.is_default && <Button size="sm" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => setDeleting(t)}><Trash2 className="h-4 w-4 text-rose-500" /></Button>}
                </>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <FormModal open={!!editing} onClose={() => { setEditing(null); setCopyOf(null); }} title={editing === 'new' ? 'New offer template' : 'Edit offer template'} size="xl" schema={schema} fields={fields}
        defaultValues={initial as never} onSubmit={(v) => save.mutateAsync(v)} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete template?" tone="danger" confirmLabel="Delete" loading={remove.isPending}
        message="Existing offers keep their generated PDFs; drafts using this template fall back to the default wording." onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </Card>
  );
}
