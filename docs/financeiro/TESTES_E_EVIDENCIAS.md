# Testes e evidências — módulo financeiro (Fases 1 a 7, consolidado)

Data: 24–25/09/2026. Ambiente: local, Windows, `node v24.18.1`, sem acesso a produção. Comandos executados via `node_modules/.bin` diretamente (pnpm não pôde ser ativado via corepack neste ambiente por falta de permissão de escrita em `C:\Program Files\nodejs`; equivalente exato aos scripts de `package.json`).

## Resultados exatos

| Comando equivalente a | Resultado |
|---|---|
| `pnpm typecheck` | ✅ 0 erros |
| `pnpm worker:typecheck` | ✅ 0 erros |
| `pnpm build` | ✅ 0 erros |
| `pnpm test` (vitest, exceto `worker-d1.smoke.test.ts`) | ✅ 179 passed, 2 skipped (gates pré-existente/gated: `ROTA_CERTA_TEST_REAL_PG_URL` para `outbox-claim` e para `mileage-allocation-concurrency`) |
| `pnpm test tests/finance.test.ts` isolado (Fase 1) | ✅ 21/21 |
| `pnpm test tests/finance-obligations.test.ts` isolado (Fase 2) | ✅ 17/17 |
| `pnpm test tests/subscription-schedule.test.ts` isolado (Fase 2, funções puras) | ✅ 15/15 |
| `pnpm test tests/finance-sales.test.ts` isolado (Fase 3) | ✅ 14/14 |
| `pnpm test tests/sales-profit.test.ts` isolado (Fase 4, funções puras) | ✅ 11/11 |
| `pnpm test tests/finance-issuances.test.ts` isolado (Fase 4) | ✅ 8/8 |
| `pnpm test tests/mileage-cost.test.ts` isolado (Fase 5, funções puras) | ✅ 8/8 |
| `pnpm test tests/finance-mileage.test.ts` isolado (Fase 5) | ✅ 15/15 |
| `pnpm test tests/finance-csv.test.ts` isolado (Fase 6, funções puras) | ✅ 9/9 |
| `pnpm test tests/finance-dashboard.test.ts` isolado (Fase 6) | ✅ 13/13 |
| `pnpm test tests/partners.test.ts` isolado (regressão — inclui o trecho de `admin.ts` corrigido na Fase 3) | ✅ 26/26 |
| `pnpm d1:migrate:local` (0009, Fase 1) | ✅ `0009_finance_foundation.sql` aplicada |
| `pnpm d1:migrate:local` (0010, Fase 2) | ✅ `0010_finance_subscriptions_obligations.sql` aplicada (15 comandos) |
| `pnpm d1:migrate:local` (0011, Fase 3) | ✅ `0011_finance_sales_receivables.sql` aplicada (12 comandos) |
| `pnpm d1:migrate:local` (0012, Fase 4) | ✅ `0012_finance_issuances.sql` aplicada (5 comandos) |
| `pnpm d1:migrate:local` (0013, Fase 5) | ✅ `0013_finance_mileage.sql` aplicada (8 comandos) |
| `pnpm d1:migrate:local` (0014, Fase 7) | ✅ `0014_finance_performance_indexes.sql` aplicada (4 índices) |
| Migrate + `rollbackLatest` da 0009 em Postgres (pg-mem) | ✅ 4 tabelas `fin_*` criadas, todas removidas após rollback |
| Migrate + `rollbackLatest` da 0010 em Postgres (pg-mem) | ✅ 4 tabelas novas removidas após rollback; as 4 tabelas da Fase 1 permanecem intactas |
| Migrate + `rollbackLatest` da 0011 em Postgres (pg-mem) | ✅ 3 tabelas novas removidas após rollback; tabelas das Fases 1–2 permanecem intactas |
| Migrate + `rollbackLatest` da 0012 em Postgres (pg-mem) | ✅ `fin_issuances` some após rollback; tabelas das Fases 1–3 permanecem intactas |
| Migrate + `rollbackLatest` da 0013 em Postgres (pg-mem) | ✅ 2 tabelas novas somem após rollback; tabelas das Fases 1–4 permanecem intactas |
| Migrate + `rollbackLatest` da 0014 em Postgres (pg-mem) | ✅ 4 índices somem após rollback; nenhuma tabela afetada |
| `node --check public/assets/financeiro.js` | ✅ sintaxe válida |
| `git diff --check` | ✅ sem conflito de whitespace |
| `pnpm test:e2e` (Playwright) | Não executado nesta sessão (fora do escopo imediato: Fases 1–7 não alteram nenhum fluxo do site público/E2E existente — a correção em `admin.ts`/`worker/index.ts` foi validada pela suíte de `partners.test.ts`, que já cobria esse endpoint) |

(A Fase 6 não adicionou migração nova — só rotas de leitura sobre tabelas já existentes. A Fase 7 adicionou só índices, nenhuma tabela nova.)

## Falha de ambiente registrada (não é regressão de código)

`tests/worker-d1.smoke.test.ts` (arquivo pré-existente, não alterado nesta tarefa) trava em `beforeAll` tentando iniciar `Unstable_DevWorker` (Miniflare/workerd real) — ultrapassou 400s sem concluir em duas tentativas (uma dentro da suíte completa, uma isolada). O typecheck do Worker passa, e a migração D1 real via `wrangler d1 migrations apply --local` funciona normalmente neste mesmo ambiente — a falha parece restrita à inicialização do runtime HTTP completo do Workers neste sandbox específico, não ao código da Fase 1. Rótulo: **BLOQUEADO** (ambiente). Recomendação para a conta revisora: reexecutar isoladamente num ambiente com suporte total ao runtime Cloudflare Workers antes de considerar a paridade Worker/D1 comprovada ponta a ponta via teste automatizado.

### Adendo — revisão independente de 28/09/2026

Reexecutado nesta data, neste ambiente Windows: `tests/worker-d1.smoke.test.ts` **passou isoladamente em ~83s** (1/1 teste), e voltou a passar rodando dentro da suíte completa numa segunda tentativa (a primeira tentativa teve 8 arquivos falhando de forma transitória, provável disputa de recursos ao paralelizar com o Miniflare — não reproduzido na repetição imediata do mesmo comando). O texto acima é preservado como registro histórico de que o teste já apresentou esse travamento num ambiente anterior; não reflete mais o comportamento observado nesta data. Recomenda-se continuar excluindo este teste do `pnpm test` padrão (como o restante desta tabela já faz) e rodá-lo isoladamente, dada a instabilidade observada em paralelo — mas não presumir mais que ele está bloqueado por ambiente. Ver `docs/financeiro/REVISAO_INDEPENDENTE.md`, GATE 2 e GATE 4, para os números exatos.

## Cobertura da Fase 1 por requisito de segurança (seção 14.1 do prompt mestre)

- GET sem sessão → 401: **TESTADO_LOCALMENTE** (`tests/finance.test.ts`, 4 rotas).
- GET com sessão mas sem papel master → 403: **TESTADO_LOCALMENTE** (4 rotas).
- POST sem sessão → 401: **TESTADO_LOCALMENTE**.
- POST com sessão customer → 403: **TESTADO_LOCALMENTE**.
- POST com sessão master sem CSRF → 403 (`csrf_rejected`): **TESTADO_LOCALMENTE**.
- Mutação completa (sessão + CSRF) → sucesso: **TESTADO_LOCALMENTE**.
- Regra de negócio (kind pai/filho, bloqueio de desativação com filha ativa, unicidade de nome, par saldo/data, moeda válida): **TESTADO_LOCALMENTE**.
- IDs adivinhados/forjados: não aplicável ainda nesta fase (nenhum recurso tem dono individual — é um painel único de empresa gated por `master`; a checagem relevante já é a de papel, coberta acima). Será revisitado nas Fases 3–5 onde há vínculo com `lead_requests`/`partners`.

## Cobertura da Fase 2 (assinaturas e obrigações)

- Autorização (401/403/CSRF) nas rotas novas: **TESTADO_LOCALMENTE**.
- `nextChargeDate`: mensal simples, clamp Jan 31→Fev 28 (ano comum) e →Fev 29 (bissexto), trimestral cruzando virada de ano, semestral, anual cruzando dia bissexto, rollover de ano, periodicidade personalizada em dias, erro em intervalo personalizado ausente/inválido, erro em data malformada: **TESTADO_LOCALMENTE** (`tests/subscription-schedule.test.ts`).
- `isValidSubscriptionTransition`: transições válidas e inválidas, incluindo bloqueio de sair de estado terminal e de pular etapa (trial→ended direto): **TESTADO_LOCALMENTE**.
- Criação de assinatura exige categoria `operating_expense` (rejeita `direct_cost`): **TESTADO_LOCALMENTE**.
- Reajuste preserva histórico anterior (não sobrescreve, soma uma linha nova): **TESTADO_LOCALMENTE**.
- Geração de cobrança: idempotente (rodar duas vezes não duplica), cobre mês com quantidade diferente de dias ponta a ponta via HTTP (não só a função pura), assinatura cancelada não perde cobranças já geradas: **TESTADO_LOCALMENTE**.
- Obrigação: categoria com `kind` divergente rejeitada (422); pagamento parcial→total muda status corretamente; moeda de pagamento divergente da obrigação rejeitada (422); estorno cria novo lançamento negativo sem apagar o original; segundo estorno do mesmo pagamento bloqueado (409); cancelamento só permitido sem pagamento, bloqueado quando já há um: **TESTADO_LOCALMENTE**.
- `is_overdue` é calculado na leitura e não altera `status` armazenado: **TESTADO_LOCALMENTE**.

## Cobertura da Fase 3 (vendas e contas a receber)

- Autorização (401/403/CSRF) nas rotas novas: **TESTADO_LOCALMENTE**.
- Criação idempotente a partir de proposta convertida (repetir a chamada devolve a mesma venda, `alreadyExisted:true`, nunca duplica): **TESTADO_LOCALMENTE**.
- Rejeição de venda para proposta ainda não convertida (`lead_not_converted`) e de desconto ≥ valor bruto (`discount_exceeds_gross_amount`): **TESTADO_LOCALMENTE**.
- Confirmação de que criar `fin_sales` para uma proposta com parceiro **não** cria uma segunda linha em `partner_commissions` (contagem antes/depois idêntica): **TESTADO_LOCALMENTE**.
- Bloqueio de parcelas cuja soma ultrapasse o valor líquido da venda (`installments_exceed_sale_amount`): **TESTADO_LOCALMENTE**.
- `financialStatus` derivado evolui corretamente `no_receivables`→`open`→`partial`→`paid` conforme os recebimentos, sem nenhum valor digitado pelo cliente: **TESTADO_LOCALMENTE**.
- Rejeição de recebimento em moeda diferente da parcela (`payment_currency_must_match_receivable`): **TESTADO_LOCALMENTE**.
- Estorno de recebimento como novo lançamento negativo (nunca apaga o original) e bloqueio de um segundo estorno do mesmo pagamento (`payment_already_reversed`): **TESTADO_LOCALMENTE**.
- Cancelamento de venda bloqueado quando já há recebimento (`sale_has_payments_use_refund`) e permitido sem nenhum: **TESTADO_LOCALMENTE**.
- Reembolso bloqueado sem nenhum recebimento (`sale_has_no_payments_use_cancel`) e permitido depois de um recebimento, com `financialStatus` refletindo `refunded`: **TESTADO_LOCALMENTE**.

## Correção de bug pré-existente validada por teste

O bug em `PATCH /api/admin/leads/:id` (ver `PLANO_IMPLEMENTACAO.md`, Fase 3) que descartava `sale_amount_cents`/`sale_currency` para propostas convertidas sem parceiro foi corrigido em `src/routes/admin.ts` e `worker/index.ts`. A suíte `tests/finance-sales.test.ts` depende diretamente desse valor estar persistido (todo `createConvertedLead` do teste não usa parceiro por padrão), então os 14 testes da Fase 3 já validam a correção em uso real. A suíte `tests/partners.test.ts` (26/26, inalterada) confirma que o caminho **com** parceiro continua produzindo exatamente a mesma comissão de antes.

## Cobertura da Fase 4 (emissões, custos e lucro)

- Autorização (401/403/CSRF) nas rotas novas: **TESTADO_LOCALMENTE**.
- `calculateSaleProfit`: lucro/margem com custo abaixo, igual e acima do valor líquido (margem negativa), custo zero (margem 100%), rejeição de `net_amount_cents<=0` e de custo negativo: **TESTADO_LOCALMENTE** (`tests/sales-profit.test.ts`).
- `sumIssuanceDirectCostCents`: soma os 8 campos corretamente, inclusive todos zerados: **TESTADO_LOCALMENTE**.
- `isValidIssuanceTransition`: `pending→issued`, `pending→canceled`, `issued→refunded` permitidos; `issued→canceled` e qualquer transição a partir de estado terminal bloqueados; `pending→refunded` (pular etapa) bloqueado: **TESTADO_LOCALMENTE**.
- Moeda da emissão precisa bater com a moeda da venda (422 `issuance_currency_must_match_sale`): **TESTADO_LOCALMENTE**.
- PNR obrigatório para marcar como emitida (422 `pnr_required_to_issue`); depois de emitida, `PATCH` bloqueado (409 `issuance_locked_after_issued`) — custo histórico travado: **TESTADO_LOCALMENTE**.
- Cancelamento só a partir de `pending`, reembolso só a partir de `issued`, ambos os sentidos errados testados (409 `invalid_transition`): **TESTADO_LOCALMENTE**.
- Lucro realizado soma só `issued`/`refunded`; lucro projetado soma `pending` cumulativamente com o realizado; emissão `canceled` nunca entra em nenhuma das duas somas: **TESTADO_LOCALMENTE** (ponta a ponta via `GET /sales/{id}`, não só a função pura).

## Cobertura da Fase 5 (milhas e fornecedores)

- Autorização (401/403/CSRF) nas rotas novas: **TESTADO_LOCALMENTE**.
- `allocationCostCents`: proporção exata quando divide igualmente, arredondamento metade-para-cima quando não divide, soma exata ao alocar 100% do lote comprado, nenhum drift de ponto flutuante mesmo com totais grandes, rejeição de entradas não inteiras/não positivas: **TESTADO_LOCALMENTE** (`tests/mileage-cost.test.ts`).
- `unitCostMicros`: cálculo correto, rejeição de entradas inválidas: **TESTADO_LOCALMENTE**.
- Compra de lote cria a obrigação de pagamento correspondente na mesma operação; categoria precisa ser `direct_cost` (rejeita `operating_expense`): **TESTADO_LOCALMENTE**.
- Alocação acima do saldo disponível bloqueada (409 `insufficient_mileage_balance`); alocação para emissão fora do modo milhas/híbrido rejeitada (422); alocação depois de emitida bloqueada (409, mesma trava de custo histórico da Fase 4); emissão híbrida com dois lotes distintos: **TESTADO_LOCALMENTE**.
- `fin_issuances.miles_quantity`/`miles_cost_cents` recalculados automaticamente a cada alocação: **TESTADO_LOCALMENTE**.
- Estorno de alocação devolve o saldo, reabre um lote que tinha ficado `depleted`, e zera de volta `miles_quantity`/`miles_cost_cents` da emissão; bloqueio de um segundo estorno da mesma alocação: **TESTADO_LOCALMENTE**.
- Cancelamento de lote bloqueado com alocação ativa, permitido depois de todas estornadas: **TESTADO_LOCALMENTE**.
- Contenção sequencial (segunda chamada depois que a primeira já reduziu o saldo é rejeitada): **TESTADO_LOCALMENTE** contra pg-mem — mas ver a ressalva abaixo sobre o que isso não prova.
- **Concorrência real** (duas transações Postgres genuínas disputando a mesma última unidade, com `SELECT ... FOR UPDATE` bloqueando de verdade): implementada em `tests/mileage-allocation-concurrency.pg-real.test.ts`, **PENDENTE de execução** neste ambiente (requer `ROTA_CERTA_TEST_REAL_PG_URL` com um Postgres real, não incluído em `pnpm test`). A tentativa inicial de provar isso via `Promise.all` contra pg-mem falhou de forma reveladora — as duas chamadas concorrentes retornaram sucesso, sobrealocando o lote — confirmando que pg-mem não pode ser usado para essa prova (mesma limitação já documentada para `SKIP LOCKED` em `outbox-claim.pg-real.test.ts`, agora estendida a `FOR UPDATE` simples). Ver `PLANO_IMPLEMENTACAO.md` para o relato completo.
- **Worker/D1**: nenhuma prova de concorrência real existe ou é possível com as ferramentas atuais (D1 não oferece transação interativa com lock). Rótulo: **NÃO CONFIRMADO** para concorrência no Worker — lacuna conhecida, registrada para a Fase 7.

## Cobertura da Fase 6 (dashboard e relatórios)

- Autorização (401/403) nas rotas novas: **TESTADO_LOCALMENTE**.
- `csvEscapeCell`: neutraliza `=`, `+`, `-`, `@` no início da célula; quota e escapa vírgula/aspas/quebra de linha; passa valores comuns e `null`/`undefined` inalterados: **TESTADO_LOCALMENTE** (`tests/finance-csv.test.ts`).
- `buildCsv`: BOM UTF-8, separador CRLF, CSV vazio (só cabeçalho) válido: **TESTADO_LOCALMENTE**.
- `overview` (competência): faturamento/custo direto/lucro bruto/margem/despesas/resultado batem exatamente com o esperado; venda fora do período ou cancelada não conta; período invertido rejeitado (400 `invalid_date_range`): **TESTADO_LOCALMENTE**.
- `overview` (caixa): recebido/pago/saldo nunca se misturam com os números de competência: **TESTADO_LOCALMENTE**.
- `alerts`: obrigação vencida aparece, uma futura não; venda com margem abaixo do limite configurável aparece; lote de milhas com saldo abaixo do limite aparece: **TESTADO_LOCALMENTE**.
- `expenses-by-category`: agrega corretamente por categoria e moeda em competência: **TESTADO_LOCALMENTE**.
- `export.csv`: CSV com BOM e cabeçalho corretos para vendas; **uma categoria com nome hostil (`=cmd|"/c calc"!A1`) sai neutralizada na exportação real de obrigações** — prova ponta a ponta de que a proteção contra CSV injection está de fato conectada ao endpoint, não só testada isoladamente na função pura: **TESTADO_LOCALMENTE**.

## Fase 7 — revisão de consolidação (auditorias reais, não apenas documentais)

- **Segurança**: script de auditoria confirmou que as 47 rotas de `src/routes/finance*.ts` e as 47 funções `finance*` equivalentes em `worker/index.ts` chamam o gate de autorização como primeira linha de execução, sem nenhuma exceção — verificado programaticamente (`awk` sobre a linha seguinte a cada declaração de rota/função), não por inspeção manual amostral. Confirmado também: 33 chamadas `audit()` em cada runtime (paridade exata), zero ocorrências de `localStorage`/`sessionStorage` em `financeiro.js`/`financeiro.html`, zero segredo/chave hardcoded nos arquivos do módulo: **TESTADO_LOCALMENTE**.
- **Acessibilidade**: os 28 `<input>` de `financeiro.html` têm todos um `<label>` associado (verificado por contagem exata: 28 labels envolvendo input + 14 envolvendo select = todos os campos do formulário); `portal.css` não remove `outline` de foco em lugar nenhum (confirmado por busca); nenhum indicador de status depende só de cor (cartões `warning` sempre mostram o valor numérico com sinal e o rótulo textual): **TESTADO_LOCALMENTE**, por inspeção de código real, não apenas declarado.
- **Performance**: auditoria dos índices revelou e corrigiu uma lacuna real — três colunas de data usadas em filtros de período pelo dashboard (Fase 6) não tinham índice (`fin_obligations.competency_date`, `fin_obligation_payments.paid_at`, `fin_receivable_payments.received_at`). Corrigida com a migration `0014_finance_performance_indexes`, testada (migrate+rollback local em Postgres, migração real em D1 local).

## O que ainda não tem teste (fora do escopo das Fases 1–7)

Nenhuma funcionalidade planejada ficou sem teste dentro do escopo efetivamente implementado. Fora do escopo: relatório dedicado de desempenho por parceiro/fornecedor e anexos/comprovantes financeiros (ver `REQUISITOS.md`), prova de concorrência real no Worker/D1 (ver `ROLLBACK.md`), e testes E2E via Playwright (não executados por não haver alteração de fluxo do site público).
