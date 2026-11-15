// Client-side PDF generation (jsPDF). Used for offer letters (also attached to the
// offer email via storage) and payslips. Pure functions: data in, Blob out.
import { jsPDF } from 'jspdf';
import { amountInWords, fmtDate, fmtMoneyPlain, monthName, titleCase } from './format';

export interface PdfCompany {
  name: string;
  legal_name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postal_code?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  primary_color?: string | null;
  currency?: string | null;
}

export interface OfferPdfData {
  offer_number: string;
  candidate_name: string;
  job_title: string;
  designation?: string | null;
  department?: string | null;
  reporting_manager?: string | null;
  employment_type: string;
  work_location?: string | null;
  ctc_annual: number;
  basic_monthly: number;
  hra_monthly: number;
  allowances_monthly: number;
  joining_date: string;
  expiry_date: string;
  probation_months: number;
  additional_terms?: string | null;
  issued_at?: string | null;
  candidate_signature?: string | null;
  responded_at?: string | null;
  company: PdfCompany;
  /** Offer-letter template (title/intro/terms/closing with {{placeholders}}); default wording when absent. */
  template?: OfferTemplateText | null;
}

export interface OfferTemplateText { title: string; intro: string; general_terms: string; closing: string }

export const OFFER_PLACEHOLDERS = ['candidate_name', 'role', 'department', 'department_clause', 'company_name', 'joining_date', 'expiry_date', 'ctc', 'work_location', 'employment_type', 'probation_months'] as const;

/** Replaces {{placeholders}} in template text; unknown placeholders are left visible so authors can spot typos. */
export function renderOfferText(text: string, o: OfferPdfData): string {
  const c = o.company;
  const role = o.designation || o.job_title;
  const vars: Record<string, string> = {
    candidate_name: o.candidate_name, role, department: o.department ?? '', department_clause: o.department ? ` in the ${o.department} department` : '',
    company_name: c.legal_name || c.name, joining_date: fmtDate(o.joining_date), expiry_date: fmtDate(o.expiry_date),
    ctc: fmtMoneyPlain(o.ctc_annual, c.currency || 'INR'), work_location: o.work_location || 'As communicated by HR',
    employment_type: titleCase(o.employment_type), probation_months: String(o.probation_months),
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

function hexToRgb(hex?: string | null): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [37, 73, 235];
}

function companyAddress(c: PdfCompany): string {
  return [c.address, c.city, c.state, c.postal_code, c.country].filter(Boolean).join(', ');
}

function header(doc: jsPDF, c: PdfCompany, title: string) {
  const [r, g, b] = hexToRgb(c.primary_color);
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(r, g, b);
  doc.rect(0, 0, w, 78, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(c.legal_name || c.name, 40, 40);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const contact = [companyAddress(c), c.email, c.phone, c.website].filter(Boolean).join('  |  ');
  doc.text(doc.splitTextToSize(contact || ' ', w - 80), 40, 58);
  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(title, 40, 112);
}

function footer(doc: jsPDF, text: string) {
  const pages = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(226, 232, 240);
    doc.line(40, h - 40, w - 40, h - 40);
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.setFont('helvetica', 'normal');
    doc.text(text, 40, h - 26);
    doc.text(`Page ${i} of ${pages}`, w - 40, h - 26, { align: 'right' });
  }
}

class Cursor {
  y: number;
  constructor(private doc: jsPDF, start: number) {
    this.y = start;
  }
  ensure(space: number) {
    if (this.y + space > this.doc.internal.pageSize.getHeight() - 60) {
      this.doc.addPage();
      this.y = 50;
    }
  }
  para(text: string, opts: { size?: number; bold?: boolean; gap?: number } = {}) {
    const w = this.doc.internal.pageSize.getWidth() - 80;
    this.doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    this.doc.setFontSize(opts.size ?? 10.5);
    this.doc.setTextColor(30, 41, 59);
    const lines = this.doc.splitTextToSize(text, w) as string[];
    for (const line of lines) {
      this.ensure(16);
      this.doc.text(line, 40, this.y);
      this.y += (opts.size ?? 10.5) * 1.45;
    }
    this.y += opts.gap ?? 6;
  }
  table(rows: [string, string][], opts: { header?: [string, string]; boldLast?: boolean } = {}) {
    const w = this.doc.internal.pageSize.getWidth() - 80;
    const all = opts.header ? [opts.header, ...rows] : rows;
    all.forEach((row, i) => {
      this.ensure(22);
      const isHeader = !!opts.header && i === 0;
      const isLast = opts.boldLast && i === all.length - 1;
      if (isHeader) {
        this.doc.setFillColor(241, 245, 249);
        this.doc.rect(40, this.y - 14, w, 22, 'F');
      }
      this.doc.setFont('helvetica', isHeader || isLast ? 'bold' : 'normal');
      this.doc.setFontSize(10);
      this.doc.setTextColor(30, 41, 59);
      this.doc.text(row[0], 48, this.y);
      this.doc.text(row[1], 40 + w - 8, this.y, { align: 'right' });
      this.doc.setDrawColor(226, 232, 240);
      this.doc.line(40, this.y + 8, 40 + w, this.y + 8);
      this.y += 22;
    });
    this.y += 10;
  }
}

export function generateOfferPdf(o: OfferPdfData): Blob {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const c = o.company;
  const cur = c.currency || 'INR';
  const t = o.template;
  header(doc, c, t?.title?.trim() || 'Offer of Employment');
  const cur2 = new Cursor(doc, 134);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(100, 116, 139);
  doc.text(`Ref: ${o.offer_number}`, 40, cur2.y);
  doc.text(`Date: ${fmtDate(o.issued_at ?? new Date())}`, doc.internal.pageSize.getWidth() - 40, cur2.y, { align: 'right' });
  cur2.y += 26;

  const role = o.designation || o.job_title;
  cur2.para(`Dear ${o.candidate_name},`, { bold: true });
  cur2.para(t ? renderOfferText(t.intro, o) :
    `We are delighted to offer you the position of ${role}${o.department ? ` in the ${o.department} department` : ''} at ${c.legal_name || c.name}. ` +
      `This letter sets out the principal terms of your employment. We were impressed by your experience and believe you will be a great addition to our team.`,
  );
  cur2.para('1. Position & Joining', { bold: true, size: 11.5, gap: 2 });
  cur2.table([
    ['Designation', role],
    ['Employment type', titleCase(o.employment_type)],
    ['Work location', o.work_location || 'As communicated by HR'],
    ['Reporting to', o.reporting_manager || 'As communicated by HR'],
    ['Date of joining', fmtDate(o.joining_date)],
    ['Probation period', o.probation_months > 0 ? `${o.probation_months} months` : 'Not applicable'],
  ]);
  cur2.para('2. Compensation', { bold: true, size: 11.5, gap: 2 });
  const grossMonthly = Number(o.basic_monthly) + Number(o.hra_monthly) + Number(o.allowances_monthly);
  cur2.table(
    [
      ['Basic salary', fmtMoneyPlain(o.basic_monthly, cur)],
      ['House rent allowance (HRA)', fmtMoneyPlain(o.hra_monthly, cur)],
      ['Other allowances', fmtMoneyPlain(o.allowances_monthly, cur)],
      ['Gross monthly salary', fmtMoneyPlain(grossMonthly, cur)],
      ['Annual cost to company (CTC)', fmtMoneyPlain(o.ctc_annual, cur)],
    ],
    { header: ['Component', 'Monthly / Annual'], boldLast: true },
  );
  cur2.para(`Annual CTC in words: ${cur} ${amountInWords(o.ctc_annual)} only.`, { size: 9.5 });
  cur2.para('3. General Terms', { bold: true, size: 11.5, gap: 2 });
  cur2.para(t ? renderOfferText(t.general_terms, o) :
    'Your employment will be governed by the company policies in force from time to time. This offer is contingent upon satisfactory ' +
      'verification of your documents and background. Statutory deductions (provident fund, professional tax and income tax) will apply as per law.',
  );
  if (o.additional_terms?.trim()) cur2.para(o.additional_terms.trim());
  cur2.para(t ? renderOfferText(t.closing, o) :
    `Please confirm your acceptance by ${fmtDate(o.expiry_date)} using the secure link shared with you by email. This offer lapses automatically if not accepted by that date.`,
  );
  cur2.ensure(120);
  cur2.y += 10;
  cur2.para(`For ${c.legal_name || c.name}`, { bold: true, gap: 26 });
  cur2.para('Authorised Signatory', { size: 9.5, gap: 18 });
  if (o.candidate_signature) {
    doc.setDrawColor(16, 185, 129);
    doc.setFillColor(236, 253, 245);
    const w = doc.internal.pageSize.getWidth() - 80;
    cur2.ensure(60);
    doc.roundedRect(40, cur2.y - 4, w, 48, 6, 6, 'FD');
    doc.setTextColor(6, 95, 70);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text(`Accepted electronically by ${o.candidate_signature}`, 52, cur2.y + 16);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`on ${fmtDate(o.responded_at, 'dd MMM yyyy, hh:mm a')} via secure offer link`, 52, cur2.y + 32);
    cur2.y += 60;
  }
  footer(doc, `${o.offer_number} · Private & confidential`);
  return doc.output('blob');
}

export interface PayslipPdfData {
  period_year: number;
  period_month: number;
  employee_name: string;
  employee_code: string;
  designation_title?: string | null;
  department_name?: string | null;
  pan_number?: string | null;
  bank_name?: string | null;
  bank_account_last4?: string | null;
  joining_date?: string | null;
  working_days: number;
  paid_days: number;
  lop_days: number;
  basic: number;
  hra: number;
  allowances: number;
  gross: number;
  pf: number;
  professional_tax: number;
  tds: number;
  other_deductions: number;
  total_deductions: number;
  net_pay: number;
  company: PdfCompany;
}

export function generatePayslipPdf(p: PayslipPdfData): Blob {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const cur = p.company.currency || 'INR';
  header(doc, p.company, `Payslip — ${monthName(p.period_month)} ${p.period_year}`);
  const c = new Cursor(doc, 140);
  const w = doc.internal.pageSize.getWidth() - 80;
  const details: [string, string][] = [
    ['Employee name', p.employee_name],
    ['Employee code', p.employee_code],
    ['Designation', p.designation_title || '—'],
    ['Department', p.department_name || '—'],
    ['Date of joining', fmtDate(p.joining_date)],
    ['PAN', p.pan_number || '—'],
    ['Bank account', p.bank_name ? `${p.bank_name} ****${p.bank_account_last4 ?? ''}` : '—'],
    ['Working / paid / LOP days', `${p.working_days} / ${p.paid_days} / ${p.lop_days}`],
  ];
  doc.setFontSize(9.5);
  details.forEach((d, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 40 + col * (w / 2);
    const y = c.y + row * 30;
    doc.setTextColor(100, 116, 139);
    doc.setFont('helvetica', 'normal');
    doc.text(d[0], x, y);
    doc.setTextColor(30, 41, 59);
    doc.setFont('helvetica', 'bold');
    doc.text(d[1], x, y + 13);
  });
  c.y += Math.ceil(details.length / 2) * 30 + 16;
  c.table(
    [
      ['Basic salary', fmtMoneyPlain(p.basic, cur)],
      ['House rent allowance', fmtMoneyPlain(p.hra, cur)],
      ['Other allowances', fmtMoneyPlain(p.allowances, cur)],
      ['Gross earnings', fmtMoneyPlain(p.gross, cur)],
    ],
    { header: ['Earnings', 'Amount'], boldLast: true },
  );
  c.table(
    [
      ['Provident fund', fmtMoneyPlain(p.pf, cur)],
      ['Professional tax', fmtMoneyPlain(p.professional_tax, cur)],
      ['Income tax (TDS)', fmtMoneyPlain(p.tds, cur)],
      ['Other deductions', fmtMoneyPlain(p.other_deductions, cur)],
      ['Total deductions', fmtMoneyPlain(p.total_deductions, cur)],
    ],
    { header: ['Deductions', 'Amount'], boldLast: true },
  );
  const [r, g, b] = hexToRgb(p.company.primary_color);
  doc.setFillColor(r, g, b);
  doc.roundedRect(40, c.y, w, 56, 6, 6, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('Net pay', 54, c.y + 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(fmtMoneyPlain(p.net_pay, cur), 40 + w - 14, c.y + 26, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(`${cur} ${amountInWords(p.net_pay)} only`, 54, c.y + 42);
  footer(doc, 'This is a system-generated payslip and does not require a signature.');
  return doc.output('blob');
}

/** Small realistic resume PDF (used to seed demo data). */
export function generateSampleResume(name: string, title: string, email: string, skills: string[], years: number): Blob {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text(name, 40, 60);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(`${title} · ${years} years experience · ${email}`, 40, 82);
  const c = new Cursor(doc, 120);
  c.para('Summary', { bold: true, size: 13 });
  c.para(`${title} with ${years} years of hands-on experience delivering production software and collaborating with cross-functional teams.`);
  c.para('Skills', { bold: true, size: 13 });
  c.para(skills.join(' · '));
  c.para('Experience', { bold: true, size: 13 });
  c.para(`${title}, Previous Company (${new Date().getFullYear() - years} – present): led key initiatives, mentored peers and improved delivery speed.`);
  return doc.output('blob');
}

export interface ReportPdfInput {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: string[][];
  totals?: string[] | null;
  company: PdfCompany;
  numeric?: boolean[];
}

/** Tabular report as a landscape A4 PDF: branded header, repeated column headers, totals row, page numbers. */
export function generateReportPdf(r: ReportPdfInput): Blob {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const left = 32;
  const usable = W - left * 2;
  header(doc, r.company, r.title);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  if (r.subtitle) doc.text(r.subtitle, W - 40, 40, { align: 'right' });
  doc.text(`Generated ${fmtDate(new Date(), 'dd MMM yyyy, hh:mm a')} · ${r.rows.length} rows`, W - 40, 56, { align: 'right' });

  // column widths proportional to content length (clamped), scaled to the page
  const sample = [r.columns, ...r.rows.slice(0, 200), ...(r.totals ? [r.totals] : [])];
  const weights = r.columns.map((_, i) => Math.min(40, Math.max(6, ...sample.map((row) => String(row[i] ?? '').length))));
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / sum) * usable);
  const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const fs = r.columns.length > 10 ? 7 : 8;
  let y = 104;

  const drawRow = (cells: string[], kind: 'head' | 'body' | 'total', shade: boolean) => {
    doc.setFont('helvetica', kind === 'body' ? 'normal' : 'bold');
    doc.setFontSize(fs);
    const lines = cells.map((c, i) => (doc.splitTextToSize(String(c ?? ''), widths[i] - 8) as string[]).slice(0, 2));
    const h = Math.max(...lines.map((l) => l.length)) * (fs + 3) + 8;
    if (y + h > H - 50) {
      doc.addPage();
      y = 40;
      if (kind !== 'head') drawRow(r.columns, 'head', false);
      doc.setFont('helvetica', kind === 'body' ? 'normal' : 'bold');
      doc.setFontSize(fs);
    }
    if (kind === 'head' || kind === 'total' || shade) {
      doc.setFillColor(...((kind === 'head' ? [241, 245, 249] : kind === 'total' ? [226, 232, 240] : [248, 250, 252]) as [number, number, number]));
      doc.rect(left, y, usable, h, 'F');
    }
    doc.setTextColor(30, 41, 59);
    lines.forEach((l, i) => {
      const right = kind !== 'head' && r.numeric?.[i];
      l.forEach((t, k) => doc.text(t, right ? xs[i] + widths[i] - 4 : xs[i] + 4, y + 11 + k * (fs + 3), right ? { align: 'right' } : undefined));
    });
    y += h;
  };
  drawRow(r.columns, 'head', false);
  r.rows.forEach((row, i) => drawRow(row, 'body', i % 2 === 1));
  if (r.totals) drawRow(r.totals, 'total', false);
  footer(doc, `${r.company.legal_name || r.company.name} · ${r.title} · Confidential`);
  return doc.output('blob');
}
