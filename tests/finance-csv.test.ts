import { describe, expect, it } from 'vitest';
import { buildCsv, csvEscapeCell } from '../shared/financeCsv.js';

describe('csvEscapeCell', () => {
  it('neutralizes formula-triggering prefixes with a leading apostrophe', () => {
    // Also contains double quotes, so it is additionally wrapped and its internal quotes doubled.
    expect(csvEscapeCell('=cmd|"/c calc"!A1')).toBe('"\'=cmd|""/c calc""!A1"');
    expect(csvEscapeCell('+1234')).toBe("'+1234");
    expect(csvEscapeCell('-1234')).toBe("'-1234");
    expect(csvEscapeCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('leaves an ordinary negative number-looking string alone when it is not a formula trigger risk beyond the leading char', () => {
    // Still neutralized: a leading "-" is itself the trigger, regardless of what follows.
    expect(csvEscapeCell('-42.50')).toBe("'-42.50");
  });

  it('quotes and escapes a value containing a comma', () => {
    expect(csvEscapeCell('Lisboa, Portugal')).toBe('"Lisboa, Portugal"');
  });

  it('quotes and doubles internal double quotes', () => {
    expect(csvEscapeCell('Voo "direto"')).toBe('"Voo ""direto"""');
  });

  it('quotes a value containing a newline', () => {
    expect(csvEscapeCell('linha 1\nlinha 2')).toBe('"linha 1\nlinha 2"');
  });

  it('passes through an ordinary value unchanged', () => {
    expect(csvEscapeCell('RC-20260101-ABC123')).toBe('RC-20260101-ABC123');
    expect(csvEscapeCell(12345)).toBe('12345');
    expect(csvEscapeCell(true)).toBe('true');
  });

  it('renders null/undefined as an empty cell', () => {
    expect(csvEscapeCell(null)).toBe('');
    expect(csvEscapeCell(undefined)).toBe('');
  });
});

describe('buildCsv', () => {
  it('builds a BOM-prefixed, CRLF-separated CSV with escaped headers and rows', () => {
    const csv = buildCsv(['Protocolo', 'Valor'], [['RC-1', 100], ['=HYPERLINK("http://evil")', -50]]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('Protocolo,Valor\r\n');
    expect(csv).toContain("RC-1,100\r\n");
    expect(csv).toContain("'=HYPERLINK(\"\"http://evil\"\")");
  });

  it('produces an empty-but-valid CSV (header only) for zero rows', () => {
    const csv = buildCsv(['A', 'B'], []);
    expect(csv).toBe('﻿A,B\r\n');
  });
});
