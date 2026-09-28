# Regras de cálculo — módulo financeiro

Todos os indicadores são calculados no servidor a partir de componentes persistidos (nunca aceitos prontos do cliente), sempre separados por moeda (nunca somando moedas diferentes num único total), e sempre rotulados como **caixa** (realizado, recebimentos/pagamentos liquidados) ou **competência** (projetado, faturamento/despesa reconhecidos independente de liquidação).

Estas definições valem a partir da Fase 6 (dashboard/relatórios), mas ficam registradas aqui desde a Fase 1 para que nenhuma fase futura as implemente de forma divergente.

- **Faturamento bruto** (competência): soma de `fin_sales.net_amount_cents` das vendas com `status='confirmed'` cuja `sale_date` cai no período, por moeda.
- **Recebido** (caixa): soma de `fin_receivable_payments.received_amount_cents` com `received_at` no período, por moeda. Estornos entram como valor negativo na mesma soma (nunca um `DELETE`).
- **Custo direto**: soma dos custos de `fin_issuances` (`cash_amount_cents` + taxas + comissão + custo de milhas alocado, via `fin_mileage_allocations.cost_cents_snapshot`) atribuídos a vendas confirmadas do período, por moeda.
- **Lucro bruto** = Faturamento bruto (competência) − Custo direto atribuído, por moeda. Nunca subtrai custo de uma moeda do faturamento de outra.
- **Margem bruta** = Lucro bruto / Faturamento bruto, somente quando Faturamento bruto > 0; caso contrário o indicador é exibido como "sem faturamento no período", nunca `NaN`/`Infinity`/divisão por zero silenciosa.
- **Despesas operacionais** (competência): soma de `fin_obligations` com `kind='operating_expense'` e `competency_date` no período, por moeda.
- **Resultado operacional** = Lucro bruto − Despesas operacionais reconhecidas, por moeda. Nunca chamado de "lucro líquido contábil" (impostos/obrigações contábeis não modelados nesta fase).
- **Projetado** vs **Realizado**: projetado = qualquer valor esperado ainda não liquidado (`fin_receivables`/`fin_obligations` em `open`/`partial`); realizado = soma efetivamente liquidada (`fin_receivable_payments`/`fin_obligation_payments`).

## Conversão de moeda (quando existir, fases futuras)
Nunca busca câmbio automaticamente. Se um valor precisar ser convertido para exibição consolidada, o snapshot grava: moeda original, valor original, taxa usada, data da taxa, valor convertido — tudo persistido, nunca recalculado silenciosamente depois.

## Datas
Vencimento (`due_date`, `competency_date`) é `date` (dia civil, sem fuso). Eventos e auditoria usam `timestamptz` UTC, seguindo o padrão já existente em `audit_events.created_at` e `sessions.expires_at`.
