/**
 * Custo de milhas com precisão decimal segura — nunca `float`. `totalCostCents` e
 * `quantityPurchased` vêm sempre de um lote real; a proporção é calculada com `BigInt` (precisão
 * arbitrária, sem arredondamento intermediário), e só a divisão final arredonda (metade para
 * cima) para um `number` de centavos inteiros — o mesmo padrão de "dinheiro sempre em centavos"
 * do resto do projeto, só que sem passar por nenhuma etapa de ponto flutuante.
 */
export function allocationCostCents(totalCostCents: number, quantityPurchased: number, quantityAllocated: number): number {
  if (!Number.isInteger(totalCostCents) || totalCostCents <= 0) throw new Error('invalid_total_cost');
  if (!Number.isInteger(quantityPurchased) || quantityPurchased <= 0) throw new Error('invalid_quantity_purchased');
  if (!Number.isInteger(quantityAllocated) || quantityAllocated <= 0) throw new Error('invalid_quantity_allocated');
  const numerator = BigInt(totalCostCents) * BigInt(quantityAllocated);
  const denominator = BigInt(quantityPurchased);
  const roundedHalfUp = (numerator + denominator / 2n) / denominator;
  return Number(roundedHalfUp);
}

/** Custo médio por milha em micros de centavo (1 centavo = 1_000_000 micros) — só informativo/exibição, nunca usado para recalcular o custo de uma alocação já criada. */
export function unitCostMicros(totalCostCents: number, quantityPurchased: number): number {
  if (!Number.isInteger(totalCostCents) || totalCostCents <= 0) throw new Error('invalid_total_cost');
  if (!Number.isInteger(quantityPurchased) || quantityPurchased <= 0) throw new Error('invalid_quantity_purchased');
  return Number((BigInt(totalCostCents) * 1_000_000n) / BigInt(quantityPurchased));
}
