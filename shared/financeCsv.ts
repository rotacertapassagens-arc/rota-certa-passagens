/**
 * CSV UTF-8 seguro para exportação financeira (seção 11.7 do prompt mestre): protegido contra
 * "CSV injection" (uma célula começando com `=`, `+`, `-`, `@`, tab ou CR é interpretada como
 * fórmula por Excel/Sheets ao abrir o arquivo — prefixamos com um apóstrofo para neutralizar,
 * mesma mitigação recomendada pelo OWASP) e com escaping RFC 4180 correto (aspas duplicadas,
 * célula entre aspas quando contém vírgula/aspas/quebra de linha).
 */
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

export function csvEscapeCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_TRIGGER_RE.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildCsv(headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const lines = [headers.map(csvEscapeCell).join(',')];
  for (const row of rows) lines.push(row.map(csvEscapeCell).join(','));
  // BOM UTF-8 no início: sem ele, o Excel abre acentos/­símbolos de moeda como texto corrompido.
  return `﻿${lines.join('\r\n')}\r\n`;
}
