/**
 * D1 grava CURRENT_TIMESTAMP como 'YYYY-MM-DD HH:MM:SS' (espaço). Comparar isso com um ISO
 * ('...T...Z') como texto deixa de fora tudo criado no próprio dia do limite, porque ' ' < 'T'.
 * Sempre converter o limite com esta função antes de comparar com colunas do D1.
 */
export function d1Timestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}
