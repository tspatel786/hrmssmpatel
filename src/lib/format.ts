import { format, formatDistanceToNow, isValid, parseISO } from 'date-fns';

export function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : v.length <= 10 ? parseISO(v) : new Date(v);
  return isValid(d) ? d : null;
}

export const fmtDate = (v: string | Date | null | undefined, pattern = 'dd MMM yyyy') => {
  const d = toDate(v);
  return d ? format(d, pattern) : '—';
};
export const fmtDateTime = (v: string | Date | null | undefined) => fmtDate(v, 'dd MMM yyyy, hh:mm a');
export const fmtTime = (v: string | Date | null | undefined) => fmtDate(v, 'hh:mm a');
export const fmtRelative = (v: string | Date | null | undefined) => {
  const d = toDate(v);
  return d ? formatDistanceToNow(d, { addSuffix: true }) : '—';
};

export function fmtMoney(n: number | null | undefined, currency = 'INR', compact = false): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: compact ? 1 : 0,
      notation: compact ? 'compact' : 'standard',
    }).format(Number(n));
  } catch {
    return `${currency} ${Number(n).toLocaleString()}`;
  }
}

/** Plain-ASCII money for PDFs (core PDF fonts have no ₹ glyph). */
export function fmtMoneyPlain(n: number | null | undefined, currency = 'INR'): string {
  const v = Number(n ?? 0);
  const s = v.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${s}`;
}

export const fmtNumber = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));

export function initials(name?: string | null): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function titleCase(s?: string | null): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

export function fileSize(bytes?: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export const monthName = (m: number) => format(new Date(2000, m - 1, 1), 'MMMM');

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
}
function threeDigits(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
}
/** Indian numbering system (lakh / crore) amount in words. */
export function amountInWords(amount: number): string {
  let n = Math.floor(Math.abs(amount));
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return parts.join(' ');
}
