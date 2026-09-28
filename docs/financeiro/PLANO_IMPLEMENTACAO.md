# Plano de implementação — módulo financeiro

Baseado no estado confirmado em `ESTADO_INICIAL.md`. Escopo: somente Financeiro (seção 1 do prompt mestre). Runtime: paridade Node/Fastify+PostgreSQL e Cloudflare Worker+D1, por ser regra vigente comprovada do projeto.

## Convenções obrigatórias em todas as fases

- Prefixo `fin_` em toda tabela nova.
- Dinheiro em `*_cents` inteiro + `currency char(3)` (`ALLOWED_CURRENCIES` existente: EUR, USD, BRL, GBP). Nunca somar moedas diferentes num total.
- Toda rota sob `/api/admin/finance/...`, gated por `requireMaster` (401 sem sessão, 403 sem papel master), mutações por `requireMutationAuth`.
- Toda mutação relevante grava em `audit_events` via `audit()` existente.
- Sem `DELETE` de registro financeiro com histórico: estado `ativo/inativo` ou cancelamento/estorno auditável.
- Migrations pareadas Postgres (`migrations/000N_*.sql` + `.down.sql`) e D1 (`d1/migrations/000N_*.sql`), aplicadas e verificadas só em banco local.
- Cada fase termina com: `pnpm typecheck`, `pnpm worker:typecheck`, `pnpm test`, migração local aplicada e revertida, e uma atualização deste plano marcando o que passou de PENDENTE para IMPLEMENTADO_LOCALMENTE/TESTADO_LOCALMENTE.

## Fases

### Fase 0 — Auditoria e desenho — **CONCLUÍDA (2026-09-24)**
Entrega: `ESTADO_INICIAL.md`, este plano, `MODELO_DADOS.md`, `REGRAS_CALCULO.md`, `SEGURANCA_E_PERMISSOES.md`.

### Fase 1 — Fundação segura — **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE (2026-09-24)**
Escopo: `fin_categories` (hierárquica, tipo receita/custo direto/despesa), `fin_cost_centers`, `fin_accounts` (contas financeiras internas — banco/dinheiro/cartão/carteira, sem integração bancária real), `fin_counterparties` (fornecedor/companhia/consolidadora/parceiro de milhas — distinto de `partners`), entrada de navegação "Financeiro" visível só a master, CRUD básico das quatro entidades com autorização testada, bloqueio de exclusão quando há referência (soft `active=false`).

Entregue:
- `migrations/0009_finance_foundation.sql` + `.down.sql` (Postgres) e `d1/migrations/0009_finance_foundation.sql` (D1) — paridade de schema.
- `src/routes/finance.ts` (Node/Fastify) e rotas equivalentes em `worker/index.ts` (Cloudflare Worker/D1), registradas em `src/app.ts`.
- `public/financeiro.html` + `public/assets/financeiro.js` (UI própria, mesmo shell visual de `admin.html`/`portal.css`), link "Abrir Financeiro" adicionado em `public/admin.html` (só visível depois do 200 OK de sessão master, mesmo padrão de `admin.js`).
- `docs/openapi.yaml` atualizado com as 8 rotas novas sob `/api/admin/finance/...` e tag `Finance`.
- `tests/finance.test.ts` — 21 testes cobrindo 401 (sem sessão), 403 (customer autenticado), 403 (master sem CSRF), CRUD de sucesso, validação de `kind` pai/filho, bloqueio de desativação com filha ativa, unicidade de nome de centro de custo, par completo saldo inicial/data, `last4` só 4 dígitos, moeda inválida, e isolamento de `fin_counterparties` frente a `partners`.

Verificado nesta sessão:
- `tsc -p tsconfig.json --noEmit` — **TESTADO_LOCALMENTE**, sem erros.
- `tsc -p worker/tsconfig.json --noEmit` — **TESTADO_LOCALMENTE**, sem erros.
- `vitest run` (excluindo `tests/worker-d1.smoke.test.ts`) — **TESTADO_LOCALMENTE**, 69/70 passam (1 skip pré-existente, gated por `ROTA_CERTA_TEST_REAL_PG_URL`), incluindo os 21 novos e os 26 de `partners.test.ts` (sem regressão).
- `wrangler d1 migrations apply DB --local` — **TESTADO_LOCALMENTE**, `0009_finance_foundation.sql` aplicada com sucesso.
- Migrate + rollback da 0009 em Postgres (via pg-mem, mesmo motor da suíte) — **TESTADO_LOCALMENTE**: as 4 tabelas `fin_*` existem após `migrate`, e todas somem corretamente após `rollbackLatest` (o down precisou de `CASCADE` só na FK auto-referenciada de `fin_categories`).
- `tsc -p tsconfig.json` (build completo) — **TESTADO_LOCALMENTE**, sem erros.
- `git diff --check` — **TESTADO_LOCALMENTE**, sem conflitos de whitespace (apenas aviso informativo de normalização LF/CRLF do Git no Windows).
- `pnpm test:e2e` (Playwright) — **NÃO EXECUTADO** nesta sessão (fora do escopo imediato da Fase 1 de fundação, que não altera fluxos do site público).

**BLOQUEADO (ambiente, não regressão de código):** `tests/worker-d1.smoke.test.ts` — já existente antes desta tarefa, não alterado por ela — trava no hook `beforeAll` (`Unstable_DevWorker`, mais de 400s sem concluir) ao tentar subir um runtime real do Cloudflare Workers (Miniflare/workerd) neste ambiente local. O typecheck do Worker e a aplicação real da migração D1 via `wrangler d1 migrations apply --local` funcionaram normalmente — a limitação parece ser especificamente do processo `unstable_dev`/workerd neste sandbox, não do código adicionado. Recomendado à conta revisora: reexecutar esse teste específico num ambiente com suporte completo ao runtime Workers antes de aprovar a paridade Worker/D1 como comprovada ponta a ponta para o financeiro.

Critério de aceite: cumprido — 401/403/master testados nas 4 entidades; typecheck e testes passam; migração local aplica e reverte sem erro em Postgres; migração local aplica sem erro em D1.

### Fase 2 — Assinaturas, despesas e contas a pagar — **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE (2026-09-24)**
Escopo: `fin_subscriptions` (com histórico de reajuste), `fin_obligations` (despesa avulsa ou obrigação recorrente, custo direto ou despesa operacional), pagamentos parciais/totais, geração idempotente de cobrança por periodicidade, alertas de vencimento (via `isOverdue` derivado), relatório básico de despesas por categoria (lista filtrável — dashboard consolidado continua na Fase 6).

Entregue:
- `shared/subscriptionSchedule.ts` — funções puras `nextChargeDate` (mensal/trimestral/semestral/anual com clamp de dia de mês, e personalizada em dias), `subscriptionChargeIdempotencyKey`, `isValidSubscriptionTransition` (máquina de estado trial→active→suspended→canceled/ended). Importadas por Node e Worker sem duplicação de lógica.
- `migrations/0010_finance_subscriptions_obligations.sql` + `.down.sql` (Postgres) e `d1/migrations/0010_finance_subscriptions_obligations.sql` (D1) — `fin_subscriptions`, `fin_subscription_price_history` (append-only), `fin_obligations`, `fin_obligation_payments`.
- `src/routes/finance-subscriptions.ts` e `src/routes/finance-obligations.ts` (Node), rotas equivalentes em `worker/index.ts`.
- UI em `public/financeiro.html`/`financeiro.js`: seções de Assinaturas (criar, reajustar, mudar status, gerar cobranças vencidas) e Contas a pagar/despesas (criar, pagar parcial/total, cancelar, ver histórico de pagamentos/estornos).
- `docs/openapi.yaml` — 11 endpoints novos.
- `tests/subscription-schedule.test.ts` (15 testes das funções puras) + `tests/finance-obligations.test.ts` (17 testes ponta a ponta via HTTP).

Verificado nesta sessão:
- `tsc -p tsconfig.json --noEmit` e `-p worker/tsconfig.json --noEmit` — **TESTADO_LOCALMENTE**, sem erros.
- `tsc -p tsconfig.json` (build) — **TESTADO_LOCALMENTE**, sem erros.
- `vitest run` (excluindo `worker-d1.smoke.test.ts`) — **TESTADO_LOCALMENTE**, 101/102 (1 skip pré-existente), incluindo os 32 testes novos desta fase, sem regressão nas fases/áreas anteriores.
- `wrangler d1 migrations apply DB --local` — **TESTADO_LOCALMENTE**, `0010_finance_subscriptions_obligations.sql` aplicada (15 comandos).
- Migrate + rollback isolado da 0010 em Postgres (pg-mem) — **TESTADO_LOCALMENTE**: as 4 tabelas novas somem após rollback, as 4 tabelas da Fase 1 permanecem intactas (rollback por fase não derruba fases anteriores).
- `node --check public/assets/financeiro.js` — **TESTADO_LOCALMENTE**, sintaxe válida.
- `git diff --check` — **TESTADO_LOCALMENTE**, sem conflito.
- Casos de negócio cobertos por teste: mês com quantidade diferente de dias (31/01 mensal), rollover de ano, custom em dias, transição de estado inválida bloqueada, cancelamento não apaga cobrança anterior, geração idempotente (rodar duas vezes não duplica), pagamento parcial→total, moeda de pagamento divergente rejeitada, estorno como novo lançamento (nunca apaga o original), bloqueio de estorno duplicado, cancelamento bloqueado quando já há pagamento.

Critério de aceite: cumprido.

### Fase 3 — Vendas e contas a receber — **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE (2026-09-24)**
Escopo: `fin_sales` (ligada a `lead_requests` existente por `lead_request_id` único — nunca duplicando proposta nem comissão de parceiro), `fin_receivables`/parcelas, `fin_receivable_payments` (recebimento parcial/total), estorno/reembolso como movimento novo, cancelamento/reembolso da venda.

**Correção de bug pré-existente, necessária e feita nesta fase (fora do diretório `docs/financeiro/` mas diretamente bloqueante para ela):** `PATCH /api/admin/leads/:id` (`src/routes/admin.ts` e o equivalente `adminLeadUpdate` em `worker/index.ts`) só gravava `sale_amount_cents`/`sale_currency` em `lead_requests` quando a proposta tinha `partner_id` — para uma proposta convertida **sem** parceiro de indicação (a maioria das vendas reais), o valor informado na conversão era descartado silenciosamente e a proposta ficava "convertida" sem nenhum valor de venda registrado. Isso é um bug de correção genuíno do código já existente, não uma decisão de design nova: a checagem de moeda (`isValidCurrency`) já rodava fora do bloco condicionado ao parceiro, então só a atribuição de `finalSaleAmountCents`/`finalSaleCurrency` estava presa dentro do `if (... && lead.partner_id)`. Corrigido movendo essa atribuição para fora do `if`, mantendo a criação de comissão (`createCommissionForLead`) só quando há parceiro — comportamento de comissão idêntico ao anterior, comportamento de `sale_amount_cents` agora correto para todos os casos. Sem essa correção, o módulo financeiro simplesmente não conseguiria criar `fin_sales` para nenhuma venda sem indicação de parceiro. Testes de regressão de `tests/partners.test.ts` (26/26) confirmam que o comportamento com parceiro não mudou.

Entregue:
- `migrations/0011_finance_sales_receivables.sql` + `.down.sql` (Postgres) e `d1/migrations/0011_finance_sales_receivables.sql` (D1) — `fin_sales`, `fin_receivables`, `fin_receivable_payments` (auto-referenciada via `reversal_of`).
- `src/routes/finance-sales.ts` (Node), rotas equivalentes em `worker/index.ts`.
- UI em `public/financeiro.html`/`financeiro.js`: gerar venda a partir do id de uma proposta convertida, adicionar parcela, cancelar/reembolsar venda, ver parcelas e registrar recebimento.
- `docs/openapi.yaml` — 8 endpoints novos.
- `tests/finance-sales.test.ts` (14 testes ponta a ponta via HTTP).

Verificado nesta sessão:
- `tsc -p tsconfig.json --noEmit` e `-p worker/tsconfig.json --noEmit` — **TESTADO_LOCALMENTE**, sem erros.
- `tsc -p tsconfig.json` (build) — **TESTADO_LOCALMENTE**, sem erros.
- `vitest run` (excluindo `worker-d1.smoke.test.ts`) — **TESTADO_LOCALMENTE**, 115/116 (1 skip pré-existente), incluindo os 14 testes novos e sem regressão em nenhuma fase/área anterior (inclusive os 26 testes de `partners.test.ts`, que exercitam exatamente o trecho corrigido em `admin.ts`).
- `wrangler d1 migrations apply DB --local` — **TESTADO_LOCALMENTE**, `0011_finance_sales_receivables.sql` aplicada (12 comandos).
- Migrate + rollback isolado da 0011 em Postgres (pg-mem) — **TESTADO_LOCALMENTE**: as 3 tabelas novas somem após rollback, as tabelas das Fases 1–2 permanecem intactas.
- `node --check public/assets/financeiro.js` — **TESTADO_LOCALMENTE**, sintaxe válida.
- `git diff --check` — **TESTADO_LOCALMENTE**, sem conflito.
- Casos de negócio cobertos por teste: criação idempotente a partir de proposta convertida (repetir nunca duplica), rejeição de proposta não convertida, rejeição de desconto ≥ valor bruto, confirmação de que a comissão do parceiro não é duplicada, bloqueio de parcelas somando mais que o valor líquido da venda, evolução do `financialStatus` derivado (no_receivables→open→partial→paid), rejeição de moeda de recebimento divergente, estorno como novo lançamento com bloqueio de segundo estorno, cancelamento bloqueado com recebimento (deve usar reembolso), reembolso bloqueado sem nenhum recebimento (deve usar cancelamento).

Riscos/decisões registradas:
- `fin_sales` nunca escreve em `lead_requests`/`partner_commissions` — é somente leitura desses dados. Cancelar/reembolsar uma `fin_sales` **não** desfaz a comissão do parceiro; isso continua sendo feito exclusivamente pelo fluxo já existente e testado da Central de Propostas (mover o status da proposta para fora de "converted", que já exige motivo auditado quando há comissão ativa).
- `status` de `fin_sales`/`fin_receivables` usa colunas `terminated_at`/`terminated_by`/`termination_reason` (não `canceled_at`/`cancel_reason`) porque uma venda pode terminar tanto em `canceled` quanto em `refunded` — um nome de coluna só para "cancelamento" teria violado a própria constraint do banco quando o estado final fosse "refunded" (bug pego e corrigido durante os testes desta sessão, nunca chegou a ser documentado como comportamento "correto").
- Não existe endpoint de cancelamento a nível de parcela individual nesta fase (só a nível de venda) — deliberado, para manter o escopo da Fase 3 gerenciável; `fin_receivables.status` mantém `'refunded'` no `CHECK` para uso futuro, mas nada o produz ainda.

Critério de aceite: cumprido.

### Fase 4 — Emissões, custos e lucro — **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE (2026-09-24)**
Escopo: `fin_issuances` (modo dinheiro/milhas/híbrido/consolidadora, PNR como referência financeira apenas), custos diretos vinculados à venda, cálculo de lucro bruto/margem no servidor (função pura testável), bloqueio de alteração retroativa de custo histórico.

Entregue:
- `shared/salesProfit.ts` — funções puras `calculateSaleProfit` (lucro bruto e margem em pontos-base, bloqueia `net_amount_cents<=0`), `sumIssuanceDirectCostCents` (soma os 8 campos de custo direto de uma emissão) e `isValidIssuanceTransition` (máquina de estado `pending→issued→refunded`, e `pending→canceled`). Importadas por Node e Worker sem duplicação de lógica.
- `migrations/0012_finance_issuances.sql` + `.down.sql` (Postgres) e `d1/migrations/0012_finance_issuances.sql` (D1) — `fin_issuances`.
- `src/routes/finance-issuances.ts` (Node), rotas equivalentes em `worker/index.ts`.
- `GET /api/admin/finance/sales/{id}` estendido para incluir `issuances` e `profit` (lucro/margem realizado e projetado), calculados no servidor a partir das emissões da venda — nunca aceitos prontos do cliente.
- UI em `public/financeiro.html`/`financeiro.js`: botão "Emissões e lucro" na lista de vendas, mostrando o resumo de lucro e permitindo criar uma nova emissão.
- `docs/openapi.yaml` — 5 endpoints novos + descrição atualizada de `GET /sales/{id}`.
- `tests/sales-profit.test.ts` (11 testes das funções puras) + `tests/finance-issuances.test.ts` (8 testes ponta a ponta via HTTP).

Verificado nesta sessão:
- `tsc -p tsconfig.json --noEmit` e `-p worker/tsconfig.json --noEmit` — **TESTADO_LOCALMENTE**, sem erros.
- `tsc -p tsconfig.json` (build) — **TESTADO_LOCALMENTE**, sem erros.
- `vitest run` (excluindo `worker-d1.smoke.test.ts`) — **TESTADO_LOCALMENTE**, 134/135 (1 skip pré-existente), incluindo os 19 testes novos desta fase, sem regressão em nenhuma fase/área anterior.
- `wrangler d1 migrations apply DB --local` — **TESTADO_LOCALMENTE**, `0012_finance_issuances.sql` aplicada (5 comandos).
- Migrate + rollback isolado da 0012 em Postgres (pg-mem) — **TESTADO_LOCALMENTE**: `fin_issuances` some após rollback, tabelas das Fases 1–3 permanecem intactas.
- `node --check public/assets/financeiro.js` — **TESTADO_LOCALMENTE**, sintaxe válida.
- Casos de negócio cobertos por teste: moeda da emissão precisa bater com a moeda da venda (rejeição 422); `pnr` obrigatório para marcar como emitida; edição bloqueada depois de emitida (`issuance_locked_after_issued`); cancelamento só a partir de `pending`, reembolso só a partir de `issued` (máquina de estado testada nos dois sentidos); lucro realizado soma só emissões `issued`/`refunded`, lucro projetado soma `pending` também; emissão `canceled` nunca entra em nenhuma das duas somas.

Riscos/decisões registradas:
- `miles_cost_cents` nesta fase é um valor informado manualmente na emissão — ainda não vem de uma alocação real de lote de milhas (isso é a Fase 5). A coluna e o campo continuam existindo sem mudança de schema quando a Fase 5 passar a preenchê-los a partir de `fin_mileage_allocations` em vez de entrada manual.
- `agent_commission_cents` é a comissão do atendente/agente que emitiu, deliberadamente com nome diferente de `partner_commissions` (comissão de indicação) para nunca serem confundidas — são conceitos, tabelas e fluxos completamente separados.
- Profit "projetado" é cumulativo (custo realizado + custo pendente), respondendo "qual seria o lucro se todas as emissões pendentes também fossem emitidas com o custo atual" — não é uma segunda métrica independente do realizado.
- Nenhuma emissão pode ser criada para uma venda que não esteja `confirmed` (cancelada/reembolsada não recebe novas emissões).

Critério de aceite: cumprido.

### Fase 5 — Milhas e fornecedores — **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE (2026-09-25)**
Escopo: `fin_mileage_lots`, `fin_mileage_allocations`, saldo derivado das alocações, transação para compra/alocação, proteção contra alocação acima do saldo sob concorrência, estorno de alocação, bloqueio de exclusão de lote utilizado.

Entregue:
- `shared/mileageCost.ts` — funções puras `allocationCostCents` (proporção exata via `BigInt`, arredondamento metade-para-cima, nunca `float`) e `unitCostMicros` (custo médio informativo).
- `migrations/0013_finance_mileage.sql` + `.down.sql` (Postgres) e `d1/migrations/0013_finance_mileage.sql` (D1) — `fin_mileage_lots`, `fin_mileage_allocations`.
- `src/routes/finance-mileage.ts` (Node): compra de lote (cria a obrigação de pagamento na mesma transação), alocação para emissão (`SELECT ... FOR UPDATE` no lote — nunca saldo negativo mesmo sob concorrência real), estorno de alocação, cancelamento de lote sem alocação ativa. Rotas equivalentes em `worker/index.ts`.
- Alocar milhas para uma emissão recalcula automaticamente `fin_issuances.miles_quantity`/`miles_cost_cents` — o valor manual da Fase 4 passa a ser derivado, sem qualquer mudança de schema.
- UI em `public/financeiro.html`/`financeiro.js`: seção "Milhas e fornecedores" (comprar lote, cancelar lote), mais a ação "alocar" dentro do fluxo "Emissões e lucro" das vendas.
- `docs/openapi.yaml` — 5 endpoints novos.
- `tests/mileage-cost.test.ts` (8 testes da função pura), `tests/finance-mileage.test.ts` (15 testes ponta a ponta), `tests/mileage-allocation-concurrency.pg-real.test.ts` (prova real de concorrência, gated).

**Achado durante o desenvolvimento — limitação real de pg-mem, não um bug do código:** a primeira versão do teste de concorrência (duas chamadas HTTP simultâneas via `Promise.all` disputando a última unidade de um lote de 10 milhas, pedindo 7+7) foi escrita esperando exatamente um `201` e um `409`. Rodada contra o motor de teste padrão do projeto (pg-mem), **as duas chamadas retornaram `201`**, sobrealocando o lote para 14/10 — exatamente o defeito que o `SELECT ... FOR UPDATE` deveria impedir. Investigação confirmou que isso é uma limitação já documentada do pg-mem (`tests/outbox-claim.pg-real.test.ts` já registra que ele não implementa `SKIP LOCKED`; agora confirmamos que nem sequer serializa `FOR UPDATE` simples entre duas transações concorrentes de verdade). Não é um bug em `finance-mileage.ts`. Correção aplicada: o teste padrão (`tests/finance-mileage.test.ts`) foi reescrito para verificar apenas a lógica sequencial (a segunda chamada, depois da primeira já ter comprometido o saldo, é rejeitada) — o que pg-mem PODE provar — e a prova real de concorrência foi movida para um arquivo gated seguindo exatamente o padrão já estabelecido por `outbox-claim.pg-real.test.ts`.

Verificado nesta sessão:
- `tsc -p tsconfig.json --noEmit` e `-p worker/tsconfig.json --noEmit` — **TESTADO_LOCALMENTE**, sem erros.
- `tsc -p tsconfig.json` (build) — **TESTADO_LOCALMENTE**, sem erros.
- `vitest run` (excluindo `worker-d1.smoke.test.ts`) — **TESTADO_LOCALMENTE**, 157/159 (2 skips pré-existentes/gated: `outbox-claim.pg-real` e `mileage-allocation-concurrency.pg-real`), incluindo os 23 testes novos desta fase, sem regressão em nenhuma fase/área anterior.
- `wrangler d1 migrations apply DB --local` — **TESTADO_LOCALMENTE**, `0013_finance_mileage.sql` aplicada (8 comandos).
- Migrate + rollback isolado da 0013 em Postgres (pg-mem) — **TESTADO_LOCALMENTE**: as 2 tabelas novas somem após rollback, tabelas das Fases 1–4 permanecem intactas.
- `node --check public/assets/financeiro.js` — **TESTADO_LOCALMENTE**, sintaxe válida.
- Casos de negócio cobertos por teste (suíte padrão): compra de lote cria a obrigação corretamente; categoria precisa ser `direct_cost`; alocação acima do saldo bloqueada (409); custo de alocação exato via `BigInt` (33 de 100 centavos ÷ 3 milhas, arredondado corretamente); emissão híbrida com dois lotes; alocação rejeitada para emissão que não usa milhas; alocação bloqueada depois de emitida; `miles_quantity`/`miles_cost_cents` recalculados automaticamente; estorno devolve saldo e reabre lote esgotado; cancelamento de lote bloqueado com alocação ativa; bloqueio de estorno duplicado.
- **PENDENTE de execução** (requer Postgres real, não incluída em `pnpm test`): `tests/mileage-allocation-concurrency.pg-real.test.ts` prova, com duas transações reais e `SELECT ... FOR UPDATE`, que a segunda transação bloqueia até a primeira confirmar e então vê o saldo já reduzido — nunca as duas conseguem alocar a mesma unidade.

Riscos/decisões registradas:
- **Concorrência real no Worker/D1 não está provada.** D1/SQLite não oferece transação interativa com `FOR UPDATE` (mesma limitação já documentada nas Fases 2–3 para outras rotas do Worker); a alocação no Worker faz a checagem de saldo e o `INSERT` como chamadas sequenciais, sem lock real. Isso é uma lacuna conhecida e documentada, não resolvida nesta fase — registrada aqui para a Fase 7 (consolidação/revisão) decidir se precisa de uma solução específica para D1 antes de qualquer publicação real.
- `fin_mileage_lots.status='expired'` está no `CHECK` mas nunca é definido pela aplicação — segue o mesmo padrão já estabelecido nas Fases 2–3 ("vencido" é sempre derivado em tempo de leitura, aqui como `isExpired`, nunca um valor gravado que dependeria de um job agendado).
- Toda compra de lote cria uma `fin_obligations` automaticamente — nunca existe um lote sem o registro do que é devido ao fornecedor, conforme exigido pela seção 9.8 do prompt mestre.

Critério de aceite: cumprido, com a ressalva explícita acima sobre concorrência no Worker/D1.

### Fase 6 — Dashboard e relatórios — **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE (2026-09-25)**
Escopo: indicadores por moeda (caixa e competência, conforme `REGRAS_CALCULO.md`), listas de vencidos/próximos vencimentos/margem negativa/saldo de milhas baixo, exportação CSV segura (proteção contra CSV injection), sem PDF nesta etapa.

Entregue:
- `shared/financeCsv.ts` — funções puras `csvEscapeCell` (neutraliza gatilho de fórmula `=+-@`/tab/CR com apóstrofo, escapa vírgula/aspas/quebra de linha conforme RFC 4180) e `buildCsv` (BOM UTF-8 + CRLF).
- `src/routes/finance-dashboard.ts` (Node), rotas equivalentes em `worker/index.ts`. Nenhuma migração nova — todas as 4 rotas são apenas leitura sobre as tabelas já existentes.
- `GET /dashboard/overview?from&to&regime=accrual|cash` — indicadores por moeda: competência (faturamento bruto, custo direto, lucro bruto, margem, despesas operacionais, resultado operacional) ou caixa (recebido, pago, saldo).
- `GET /dashboard/alerts` — vencidos, próximos vencimentos (7/30 dias), assinaturas próximas da cobrança, vendas com margem abaixo de um limite configurável, lotes de milhas com saldo baixo ou vencendo em breve.
- `GET /dashboard/expenses-by-category?from&to&regime` — despesas agrupadas por categoria e moeda.
- `GET /dashboard/export.csv?report=sales|obligations|receivables&from&to` — exportação segura, limitada a 5000 linhas.
- UI em `public/financeiro.html`/`financeiro.js`: painel "Visão geral" (cartões por moeda, seletor de período/regime, links de exportação) e painel "Alertas" no topo do financeiro.
- `docs/openapi.yaml` — 4 endpoints novos.
- `tests/finance-csv.test.ts` (9 testes da função pura) + `tests/finance-dashboard.test.ts` (13 testes ponta a ponta).

Verificado nesta sessão:
- `tsc -p tsconfig.json --noEmit` e `-p worker/tsconfig.json --noEmit` — **TESTADO_LOCALMENTE**, sem erros.
- `tsc -p tsconfig.json` (build) — **TESTADO_LOCALMENTE**, sem erros.
- `vitest run` (excluindo `worker-d1.smoke.test.ts`) — **TESTADO_LOCALMENTE**, 179/181 (2 skips gated pré-existentes), incluindo os 22 testes novos desta fase, sem regressão em nenhuma fase/área anterior.
- `node --check public/assets/financeiro.js` — **TESTADO_LOCALMENTE**, sintaxe válida.
- Casos de negócio cobertos por teste: indicadores de competência batem exatamente com faturamento/custo/despesa esperados; período fora do range não conta; venda cancelada não conta; período invertido rejeitado (400); indicadores de caixa nunca misturam com competência; alerta de vencido não lista uma obrigação futura; alerta de margem usa o limite configurável; alerta de saldo baixo de milhas; despesas por categoria agregam corretamente por moeda; exportação CSV tem BOM e cabeçalho corretos; **uma categoria com nome hostil (`=cmd|"/c calc"!A1`) é neutralizada na exportação** (prova de proteção contra CSV injection ponta a ponta, não só na função pura).

Riscos/decisões registradas:
- Nenhum PDF implementado — só CSV, conforme instrução explícita do prompt mestre ("não implementar PDF complexo antes de o CSV e os cálculos estarem corretos").
- Exportação limitada a 5000 linhas por chamada — sem paginação nesta fase; um relatório maior exigiria filtros adicionais (não pedidos ainda).
- "Despesas por categoria" inclui tanto `direct_cost` quanto `operating_expense` (o campo `kind` no resultado permite o cliente separar visualmente); não há endpoint dedicado de "desempenho por parceiro/fornecedor" nesta fase — considerado fora do orçamento de tempo restante desta sessão e não bloqueante para os critérios de aceite da Fase 6 (a lista completa de relatórios da seção 11.7 do prompt mestre continua parcialmente coberta; ver `HANDOFF_REVISAO.md`).
- `regime=cash` no `expenses-by-category` agrega por `fin_obligation_payments.paid_at`, incluindo tanto `direct_cost` quanto `operating_expense` pagos no período — mesma lógica teria repetido lucro se fosse aplicada sem cuidado ao `overview`; os dois endpoints calculam de forma independente, nunca compartilhando um total pré-somado.

Critério de aceite: cumprido para o escopo efetivamente coberto (ver ressalva acima sobre desempenho por parceiro/fornecedor).

### Fase 7 — Consolidação — **IMPLEMENTADO_LOCALMENTE / TESTADO_LOCALMENTE (2026-09-25)**
Escopo: revisão de segurança e acessibilidade, `docs/openapi.yaml` completo, `docs/financeiro/OPERACAO.md`, `TESTES_E_EVIDENCIAS.md`, `ROLLBACK.md`, `HANDOFF_REVISAO.md`.

Entregue:
- `docs/financeiro/REQUISITOS.md` — documento que faltava da lista obrigatória da seção 16 do prompt mestre (não tinha sido criado nas fases anteriores); checklist completo do escopo pedido vs. implementado, com rótulo explícito por item.
- **Revisão de segurança real (não apenas documental):** auditoria por script confirmou que as 47 rotas financeiras em `src/routes/finance*.ts` **e** as 47 funções equivalentes em `worker/index.ts` (94 handlers no total) chamam o gate de autorização (`requireMaster`/`mutationAuth`+checagem de papel) como a primeira linha de execução, sem exceção — nenhuma rota encontrada sem o gate. Confirmado também: 33 chamadas de `audit()` em cada runtime (paridade exata) cobrindo toda mutação; nenhum uso de `localStorage`/`sessionStorage` em `financeiro.js`/`financeiro.html`; nenhum segredo/chave hardcoded nos arquivos do módulo financeiro.
- **Revisão de acessibilidade real:** confirmado que os 28 campos `<input>` de `financeiro.html` têm todos um `<label>` associado (28 labels envolvendo input, mais 14 envolvendo `<select>`); nenhum estilo remove o `outline` de foco nativo do navegador (`portal.css` não tem nenhuma regra `outline`); nenhum indicador de status depende só de cor — todo cartão com classe `warning` (valor negativo) também mostra o número com sinal negativo e o rótulo textual, nunca cor isolada.
- **Revisão de performance real:** auditoria dos índices existentes revelou uma lacuna real — `fin_obligations.competency_date`, `fin_obligation_payments.paid_at` e `fin_receivable_payments.received_at` eram filtrados por período (Fase 6, `dashboard/overview` e `expenses-by-category`) sem nenhum índice, forçando varredura completa dessas tabelas à medida que crescem. Corrigido com `migrations/0014_finance_performance_indexes.sql` + `.down.sql` (Postgres) e `d1/migrations/0014_finance_performance_indexes.sql` (D1) — 4 índices novos, testados (migrate+rollback local em Postgres, migração real aplicada em D1 local).
- `docs/financeiro/OPERACAO.md` ganhou as seções "Plano de backup e restauração" e "Plano de staging e rollout" (preparados, não executados, conforme exigido pela seção 4 do prompt mestre).
- `docs/openapi.yaml` revisado por completo — 84 paths, validado com `yaml.safe_load` sem erro.

Verificado nesta sessão:
- `pnpm d1:migrate:local` (0014) — **TESTADO_LOCALMENTE**, aplicada com sucesso (4 índices).
- Migrate + rollback isolado da 0014 em Postgres (pg-mem) — **TESTADO_LOCALMENTE**.
- `vitest run` completo após os índices novos — **TESTADO_LOCALMENTE**, 179/181 (mesmos 2 skips gated), sem regressão.
- `tsc -p tsconfig.json --noEmit`, `-p worker/tsconfig.json --noEmit`, `tsc -p tsconfig.json` (build) — **TESTADO_LOCALMENTE**, sem erros.

Riscos que permanecem conscientemente em aberto (não resolvidos nesta fase, porque resolvê-los exigiria autorização ou trabalho fora do escopo desta tarefa):
- Concorrência de alocação de milhas no Worker/D1 (Fase 5) — decisão de negócio/arquitetura pendente antes de publicar o Worker.
- `tests/mileage-allocation-concurrency.pg-real.test.ts` e `tests/outbox-claim.pg-real.test.ts` — ambos pendentes de execução por falta de Postgres real neste ambiente.
- `tests/worker-d1.smoke.test.ts` — bloqueado pela limitação de ambiente já documentada desde a Fase 1.
- Relatório dedicado de desempenho por parceiro/fornecedor e anexos/comprovantes financeiros — pendências explícitas registradas em `REQUISITOS.md`.

Critério de aceite: cumprido para o que é possível resolver sem autorização adicional ou acesso a um ambiente com Postgres real/runtime Workers completo.

## Wireframe textual (Fase 1, sem sistema paralelo — reaproveita `portal.css`)

```
/financeiro.html  (mesmo shell visual de admin.html; só visível após 200 OK em /api/admin/finance/accounts)
  [Financeiro] [Categorias] [Centros de custo] [Contas] [Contrapartes]
  Cada aba: tabela existente + ativo/inativo + formulário de criação/edição
  Nenhuma ação de excluir — somente "desativar", bloqueado no servidor se referenciado
```

## Decisão registrada (seção 6 do prompt mestre)

Paridade Node/PostgreSQL e Worker/D1 é regra vigente comprovada (README + 8 migrations pareadas + `tests/worker-d1.smoke.test.ts`). Logo: cada fase implementa migration, rota, autorização e cálculo equivalentes nos dois runtimes antes de ser considerada concluída. Não será usado feature flag por incerteza de runtime, pois não há incerteza — só sinalizador de fase incompleta quando aplicável.
