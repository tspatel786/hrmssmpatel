/** RFC 4180 CSV with formula-injection protection (cells starting with = + - @ are prefixed). */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  downloadBlob(filename, new Blob(['﻿' + toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' }));
}
