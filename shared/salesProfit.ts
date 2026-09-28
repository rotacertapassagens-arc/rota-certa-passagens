/**
 * Lucro bruto e margem de uma única venda, calculados no servidor a partir de componentes
 * persistidos — nunca aceitos prontos do cliente (ver docs/financeiro/REGRAS_CALCULO.md).
 * `netAmountCents` é sempre o valor líquido da venda (fin_sales.net_amount_cents); `directCostCents`
 * é a soma dos custos diretos das emissões dessa mesma venda, na mesma moeda (nunca mistura
 * moedas — a validação de que toda emissão usa a moeda da venda acontece na rota, não aqui).
 */
export interface SaleProfit {
  grossProfitCents: number;
  marginBps: number;
}

export function calculateSaleProfit(netAmountCents: number, directCostCents: number): SaleProfit {
  if (!Number.isInteger(netAmountCents) || netAmountCents <= 0) throw new Error('invalid_net_amount');
  if (!Number.isInteger(directCostCents) || directCostCents < 0) throw new Error('invalid_direct_cost');
  const grossProfitCents = netAmountCents - directCostCents;
  const marginBps = Math.round((grossProfitCents * 10_000) / netAmountCents);
  return { grossProfitCents, marginBps };
}

/** Soma os oito campos de custo direto de uma emissão em um único total, na moeda da própria emissão. */
export function sumIssuanceDirectCostCents(issuance: {
  cashAmountCents: number;
  milesCostCents: number;
  airportFeesCents: number;
  issuanceFeeCents: number;
  consolidatorFeeCents: number;
  gatewayFeeCents: number;
  agentCommissionCents: number;
  otherCostsCents: number;
}): number {
  return (
    issuance.cashAmountCents +
    issuance.milesCostCents +
    issuance.airportFeesCents +
    issuance.issuanceFeeCents +
    issuance.consolidatorFeeCents +
    issuance.gatewayFeeCents +
    issuance.agentCommissionCents +
    issuance.otherCostsCents
  );
}

/**
 * Máquina de estado da emissão: pendente -> emitida (exige PNR) -> reembolsada; pendente ->
 * cancelada. Uma emissão só pode ser cancelada antes de ser emitida (nada foi comprometido
 * ainda); depois de emitida, a única saída é o reembolso — mantém o histórico de custo em vez de
 * fingir que a emissão nunca existiu.
 */
const ISSUANCE_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['issued', 'canceled'],
  issued: ['refunded'],
  canceled: [],
  refunded: [],
};

export function isValidIssuanceTransition(from: string, to: string): boolean {
  return (ISSUANCE_TRANSITIONS[from] ?? []).includes(to);
}
