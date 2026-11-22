// Letters on the company letterhead: offer letters (OfferDetail) and appointment letters (on joining).
import type { Company } from '@/contexts/session';
import { api } from '@/lib/backend';
import { generateAppointmentPdf, generateExitLetterPdf, loadLetterhead, type PdfCompany } from '@/lib/pdf';

const cache = new Map<string, Promise<PdfCompany['letterhead']>>();
const sigCache = new Map<string, Promise<PdfCompany['signature']>>();

/** The company as the PDF generator needs it, with letterhead and signature images loaded (cached per URL). */
export async function pdfCompany(company: Company): Promise<PdfCompany> {
  const key = `${company.letterhead_header_url ?? ''}|${company.letterhead_footer_url ?? ''}`;
  if (!cache.has(key)) cache.set(key, loadLetterhead(company.letterhead_header_url, company.letterhead_footer_url));
  const sig = company.signature_url ?? '';
  if (!sigCache.has(sig)) sigCache.set(sig, sig ? loadLetterhead(sig, null).then((l) => l?.header ?? null) : Promise.resolve(null));
  return { ...company, letterhead: await cache.get(key)!, signature: await sigCache.get(sig)! };
}

interface EmpRow {
  id: string; company_id: string; employee_code: string; full_name: string; designation_title: string | null; department_name: string | null;
  manager_name: string | null; employment_type: string; work_location: string | null; joining_date: string; probation_end_date: string | null;
  ctc_annual: number | null; basic_monthly: number | null; hra_monthly: number | null; allowances_monthly: number | null; application_id: string | null;
}

/** Builds the appointment letter, stores it in the employee's documents and emails it (send_appointment_letter). */
export async function issueAppointmentLetter(employeeId: string, company: Company): Promise<void> {
  const { rows } = await api.db.list<EmpRow>({ table: 'v_employees', filters: [{ column: 'id', op: 'eq', value: employeeId }], count: false });
  const e = rows[0];
  if (!e) throw new Error('Employee not found');
  let offerNumber: string | null = null;
  if (e.application_id) {
    const o = await api.db.list<{ offer_number: string }>({ table: 'offers', filters: [{ column: 'application_id', op: 'eq', value: e.application_id }, { column: 'status', op: 'eq', value: 'accepted' }], count: false }).catch(() => null);
    offerNumber = o?.rows[0]?.offer_number ?? null;
  }
  const pdf = generateAppointmentPdf({
    employee_code: e.employee_code, employee_name: e.full_name, designation: e.designation_title, department: e.department_name,
    reporting_manager: e.manager_name, employment_type: e.employment_type, work_location: e.work_location, joining_date: e.joining_date,
    probation_end_date: e.probation_end_date, ctc_annual: Number(e.ctc_annual ?? 0), basic_monthly: Number(e.basic_monthly ?? 0),
    hra_monthly: Number(e.hra_monthly ?? 0), allowances_monthly: Number(e.allowances_monthly ?? 0), offer_number: offerNumber,
    company: await pdfCompany(company),
  });
  const fileName = `Appointment letter - ${e.employee_code}.pdf`;
  const path = `${e.company_id}/employees/${e.id}/appointment-letter-${Date.now()}.pdf`;
  await api.storage.upload('documents', path, new File([pdf], fileName, { type: 'application/pdf' }), 'application/pdf');
  await api.db.rpc('send_appointment_letter', { p_employee: e.id, p_path: path, p_file_name: fileName });
  void api.processEmails();
}

/** Relieving / experience letter: PDF on the letterhead, stored in the employee documents and emailed (send_exit_letter). */
export async function issueExitLetter(employeeId: string, kind: 'relieving_letter' | 'experience_letter', company: Company,
  dates: { last_working_day: string; resigned_on?: string | null }): Promise<void> {
  const { rows } = await api.db.list<EmpRow>({ table: 'v_employees', filters: [{ column: 'id', op: 'eq', value: employeeId }], count: false });
  const e = rows[0];
  if (!e) throw new Error('Employee not found');
  const pdf = generateExitLetterPdf({
    kind, employee_code: e.employee_code, employee_name: e.full_name, designation: e.designation_title, department: e.department_name,
    joining_date: e.joining_date, last_working_day: dates.last_working_day, resigned_on: dates.resigned_on, company: await pdfCompany(company),
  });
  const label = kind === 'relieving_letter' ? 'Relieving letter' : 'Experience letter';
  const fileName = `${label} - ${e.employee_code}.pdf`;
  const path = `${e.company_id}/employees/${e.id}/${kind.replace('_', '-')}-${Date.now()}.pdf`;
  await api.storage.upload('documents', path, new File([pdf], fileName, { type: 'application/pdf' }), 'application/pdf');
  await api.db.rpc('send_exit_letter', { p_employee: e.id, p_path: path, p_kind: kind, p_file_name: fileName });
  void api.processEmails();
}
