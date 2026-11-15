import { describe, expect, it } from 'vitest';
import { safeNext } from '@/pages/auth/Auth';
import { toCsv } from '@/lib/csv';
import { amountInWords } from '@/lib/format';

describe('safeNext (open-redirect protection)', () => {
  const cases: [string | null, string][] = [
    ['/app/leave', '/app/leave'],
    ['/app/communication?c=1', '/app/communication?c=1'],
    ['//evil.com', '/app'],
    ['/\\evil.com', '/app'],
    ['https://evil.com', '/app'],
    ['/app\\..\\x', '/app'],
    ['/app path', '/app'],
    [null, '/app'],
    ['', '/app'],
    ['javascript:alert(1)', '/app'],
  ];
  it.each(cases)('%s -> %s', (input, out) => {
    expect(safeNext(input)).toBe(out);
  });
});

describe('CSV export', () => {
  it('escapes quotes/commas and neutralizes formula injection', () => {
    expect(toCsv(['a', 'b'], [['=1+1', 'x,"y"'], ['@cmd', null]])).toBe('a,b\r\n\'=1+1,"x,""y"""\r\n\'@cmd,');
  });
});

describe('amountInWords (Indian numbering)', () => {
  it('formats lakhs and crores', () => {
    expect(amountInWords(1500000)).toBe('Fifteen Lakh');
    expect(amountInWords(32000000)).toBe('Three Crore Twenty Lakh');
    expect(amountInWords(1234)).toBe('One Thousand Two Hundred Thirty Four');
  });
});
