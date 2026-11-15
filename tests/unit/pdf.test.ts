// Offer-template rendering and report PDF generation (pure functions).
import { describe, expect, it } from 'vitest';
import { generateOfferPdf, generateReportPdf, renderOfferText, type OfferPdfData } from '@/lib/pdf';

const offer: OfferPdfData = {
  offer_number: 'OFR-1', candidate_name: 'Asha Rao', job_title: 'Analyst', designation: 'Data Analyst', department: 'Finance', employment_type: 'intern',
  work_location: 'Pune', ctc_annual: 600000, basic_monthly: 25000, hra_monthly: 10000, allowances_monthly: 15000,
  joining_date: '2026-12-01', expiry_date: '2026-11-25', probation_months: 0, company: { name: 'Acme', legal_name: 'Acme Pvt Ltd', currency: 'INR' },
};
const pdfText = (b: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(Buffer.from(r.result as ArrayBuffer).toString('latin1'));
  r.onerror = () => reject(r.error);
  r.readAsArrayBuffer(b);
});

describe('offer templates', () => {
  it('replaces placeholders and leaves unknown ones visible', () => {
    expect(renderOfferText('Dear {{candidate_name}}, join {{company_name}} as {{role}}{{department_clause}} on {{joining_date}}. {{oops}}', offer))
      .toBe('Dear Asha Rao, join Acme Pvt Ltd as Data Analyst in the Finance department on 01 Dec 2026. {{oops}}');
    expect(renderOfferText('CTC {{ ctc }} · {{employment_type}}', offer)).toBe('CTC INR 6,00,000.00 · Intern');
  });

  it('uses the template title and wording in the generated PDF; falls back to the standard letter', async () => {
    const withTpl = await pdfText(generateOfferPdf({ ...offer, template: { title: 'Internship Offer', intro: 'Welcome aboard {{candidate_name}}.', general_terms: 'Interns follow the code of conduct.', closing: 'Reply by {{expiry_date}}.' } }));
    expect(withTpl).toContain('Internship Offer');
    expect(withTpl).toContain('Welcome aboard Asha Rao.');
    const plain = await pdfText(generateOfferPdf(offer));
    expect(plain).toContain('Offer of Employment');
    expect(plain).toContain('We are delighted to offer you the position of Data Analyst');
  });
});

describe('report PDF', () => {
  it('renders title, headers, rows and totals across pages', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`EMP-${String(i + 1).padStart(4, '0')}`, `Person ${i + 1}`, String(i % 5)]);
    const blob = generateReportPdf({ title: 'Attendance summary', subtitle: '01 Nov 2026 – 15 Nov 2026', columns: ['Employee Code', 'Employee Name', 'Late Arrivals'],
      rows, totals: ['Total', '', '240'], numeric: [false, false, true], company: { name: 'Acme' } });
    const text = await pdfText(blob);
    expect(blob.type).toBe('application/pdf');
    expect(text).toContain('Attendance summary');
    expect(text).toContain('EMP-0120');
    expect(text).toContain('Total');
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1); // paginated
  });
});
