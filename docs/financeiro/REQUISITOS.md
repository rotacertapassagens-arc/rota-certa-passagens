# Requisitos — módulo financeiro

Extraído do prompt mestre (seções 1, 7, 8, 9 e 10). Cada item é marcado com o rótulo real do seu estado — nunca "pronto"/"funcionando" sem indicar onde foi comprovado (seção 18 do prompt mestre).

## Escopo (seção 1)

| Requisito | Estado |
|---|---|
| Assinaturas e despesas recorrentes | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 2) |
| Contas a pagar e a receber | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fases 2 e 3) |
| Entradas, saídas, recebimentos e pagamentos | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fases 2 e 3) |
| Vendas de passagens | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 3, a partir de proposta já convertida) |
| Faturamento | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 6, `dashboard/overview`) |
| Custos diretos e despesas operacionais | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fases 4 e 2) |
| Lucro bruto, margem e resultado operacional | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fases 4 e 6, por venda e consolidado) |
| Formas de pagamento e parcelamento | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 3, `method` em `fin_receivables`) |
| Modo de emissão (dinheiro/milhas/híbrido/consolidadora/outro) | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 4) |
| Programas de fidelidade | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 5, `fin_mileage_lots.program`) |
| Fornecedores/parceiros de milhas | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 1, `fin_counterparties.kind='mileage_provider'`) |
| Lotes de milhas comprados e seu custo | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 5) |
| Utilização de milhas por emissão | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 5, `fin_mileage_allocations`) |
| Taxas, comissões e outros custos vinculados à venda | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 4, 8 campos de custo por emissão) |
| Localizador e dados financeiros básicos da emissão | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (Fase 4, `pnr` como referência financeira apenas) |
| Relatórios e exportações | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** — parcial (Fase 6: despesas por categoria e CSV; **PENDENTE**: desempenho por parceiro/fornecedor dedicado) |
| Trilha de auditoria de alterações relevantes | **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE** (todas as fases, `audit_events` — 33 ações financeiras distintas confirmadas por auditoria de código, ver `TESTES_E_EVIDENCIAS.md`) |
| Módulo operacional da agência (calendário, check-in, docs de passageiro, pós-venda) | **NÃO AUTORIZADO** — explicitamente fora de escopo pelo prompt mestre, nada foi implementado |

## Limites de autorização (seção 4) — confirmação final

| Ação vedada | Executada? |
|---|---|
| `git push` | Não |
| Deploy | Não |
| Alterar DNS/Cloudflare/Worker publicado/VPS/produção | Não |
| Migração em banco remoto/produção | Não |
| Criar/alterar/apagar usuário real | Não |
| Usar dado financeiro real | Não |
| Ativar cobrança real | Não |
| Conectar conta bancária | Não |
| Enviar e-mail/WhatsApp/notificação real | Não (`EMAIL_MODE=capture` preservado) |
| Criar chave/token/credencial | Não |
| Expor segredo em código/log/documentação | Não (auditado nesta fase — ver `TESTES_E_EVIDENCIAS.md`) |
| Apagar dado ou reescrever histórico Git | Não |
| Mexer em Rota Certa OS/FinanceHub/Notion/n8n/Metricool/ORC | Não |
| Implementar módulo da agência | Não |

## Modelo financeiro (seção 8)

- Valores monetários em unidades inteiras mínimas (centavos), nunca `float`: **CONFIRMADO** em todas as tabelas e em todas as funções de cálculo (`shared/salesProfit.ts`, `shared/mileageCost.ts` usam `BigInt` para a única operação que exigia precisão além de inteiro simples).
- Moeda ISO por valor, aceitando ao menos BRL e EUR: **CONFIRMADO** — `ALLOWED_CURRENCIES` já cobria EUR/USD/BRL/GBP antes desta tarefa; reaproveitado sem alteração.
- Nunca somar moedas diferentes: **CONFIRMADO** — todo indicador agregado é agrupado por moeda (`sumByCurrency`/mapas por moeda), nunca um único total cross-moeda.
- Conceitos separados (venda, recebível, parcela, recebimento, custo direto, despesa operacional, obrigação, pagamento, emissão, compra de milhas, utilização de milhas, comissão de indicação, assinatura): **CONFIRMADO** — uma tabela dedicada por conceito (`fin_sales`, `fin_receivables`, `fin_receivable_payments`, `fin_obligations`, `fin_obligation_payments`, `fin_issuances`, `fin_mileage_lots`, `fin_mileage_allocations`, `fin_subscriptions`), e `partner_commissions` explicitamente nunca tocada.
- Definições de faturamento/recebido/custo direto/lucro bruto/margem/despesas/resultado operacional/projetado/realizado: **CONFIRMADO**, documentado em `REGRAS_CALCULO.md` e implementado sem ambiguidade em `shared/salesProfit.ts` e `src/routes/finance-dashboard.ts`.

## Modelo de dados mínimo (seção 9) — cobertura por entidade

Ver `MODELO_DADOS.md` para o detalhamento completo. Todas as entidades pedidas na seção 9 foram implementadas, exceto:
- **9.1–9.9**: todas **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE**.
- Anexos/comprovantes financeiros (metadado seguro): **PENDENTE** — nenhuma fase implementou upload ou metadado de anexo; os campos `notes` existem como texto livre, mas nenhuma validação de extensão/tamanho/tipo foi construída porque nenhum anexo real foi pedido a ponto de justificar a complexidade nesta rodada. Registrado como pendência explícita, não como "concluído".

## Estados e regras de negócio (seção 10)

Todas as máquinas de estado pedidas foram implementadas e testadas: venda (`confirmed→canceled|refunded`), recebível (`open→partial→paid`, mais `canceled`/`refunded` reservados), obrigação (`open→partial→paid`, mais `canceled`), emissão (`pending→issued→refunded`, ou `pending→canceled`), assinatura (`trial→active→suspended→canceled/ended`), lote de milhas (`active→depleted`, mais `canceled`; `expired` sempre derivado). Comissão de parceiro: preservada exatamente como já existia, nenhuma alteração de estado.

Proibições explícitas da seção 10 — todas **CONFIRMADO** por `CHECK` no banco e/ou validação no servidor: valor negativo fora de estorno (campos `_cents` com `CHECK >= 0` ou `> 0`; estornos são a única exceção documentada, via `received_amount_cents <> 0`), edição de moeda após liquidação (nenhum endpoint permite alterar `currency` de nada após criado), venda não invalida comissão paga sem ajuste formal (o módulo financeiro nunca escreve em `partner_commissions`), pagamento liquidado não pode ser apagado (nunca há `DELETE`, só estorno), venda não fecha sem moeda/valor válidos (`CHECK`s de banco), lucro nunca mistura moeda (agrupamento por moeda em toda soma), custo histórico de emissão não muda com edição posterior do fornecedor/lote (`cost_cents_snapshot` congelado via `BigInt`, nunca recalculado).

## Conclusão

Cobertura completa do escopo pedido, com duas pendências explícitas e conscientes: relatório dedicado de desempenho por parceiro/fornecedor, e anexos/comprovantes financeiros. Nenhuma outra lacuna conhecida dentro do que foi pedido para o módulo Financeiro (seção 1). Ver `HANDOFF_REVISAO.md` para os riscos de concorrência no Worker/D1, que são uma limitação de ambiente/tempo, não uma lacuna de requisito.
