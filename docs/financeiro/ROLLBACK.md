# Rollback — módulo financeiro (Fases 1 a 7, consolidado)

Nenhum deploy, push ou alteração de produção foi feito. Isto descreve rollback **local**.

## Aplicação

Reverter os commits desta tarefa (ou não mergear a branch) remove `src/routes/finance.ts`, `src/routes/finance-subscriptions.ts`, `src/routes/finance-obligations.ts`, `src/routes/finance-sales.ts`, `src/routes/finance-issuances.ts`, `src/routes/finance-mileage.ts`, `src/routes/finance-dashboard.ts`, `shared/subscriptionSchedule.ts`, `shared/salesProfit.ts`, `shared/mileageCost.ts`, `shared/financeCsv.ts`, as chamadas em `src/app.ts`, as rotas equivalentes em `worker/index.ts`, `public/financeiro.html`/`financeiro.js` e o link em `public/admin.html`. Nenhum outro arquivo do site público é afetado. A Fase 6 não introduziu nenhuma tabela — reverter seus arquivos não exige nenhuma ação de banco.

**Atenção especial:** a correção de bug em `src/routes/admin.ts` (e seu equivalente em `worker/index.ts`) — que passou a persistir `sale_amount_cents`/`sale_currency` em `lead_requests` também para propostas convertidas sem parceiro — **não** é exclusiva do módulo financeiro; é uma correção de um bug pré-existente na Central de Propostas, feita na Fase 3. Reverter essa correção especificamente reintroduziria o bug original. Se um rollback parcial for necessário, mantenha essa correção mesmo que o restante das Fases 3–5 seja revertido.

## Banco de dados

- Postgres: `pnpm db:rollback` reverte a migração mais recente aplicada. Para desfazer só a Fase 7 (índices de performance), rodar uma vez (`migrations/0014_finance_performance_indexes.down.sql` — remove só os 4 índices, nenhuma tabela). Rodar de novo desfaz a Fase 5 (`0013_finance_mileage.down.sql`), mais uma vez a Fase 4 (`0012_finance_issuances.down.sql`), mais uma vez a Fase 3 (`0011_finance_sales_receivables.down.sql` — remove `fin_receivable_payments` com `CASCADE` apenas para sua própria FK auto-referenciada em `reversal_of`, depois `fin_receivables`, `fin_sales`), mais uma vez a Fase 2 (`0010_finance_subscriptions_obligations.down.sql`), e mais uma vez a Fase 1 (`0009_finance_foundation.down.sql`). Testado localmente nesta sessão: migrate das seis migrations → rollback só da 0014 → os 4 índices somem e todas as tabelas permanecem intactas.
- D1: sem mecanismo nativo de rollback automático (mesma limitação já documentada para as migrations 0001–0008 em `docs/DEPLOY_AND_ROLLBACK.md`). Reverter localmente exigiria uma migração D1 reversa escrita à mão — não foi necessária nesta sessão porque nenhum dado real foi inserido nas tabelas `fin_*` do D1 local.

## Dados

Nenhum dado real existe nas tabelas `fin_*` (nenhuma linha foi inserida fora dos testes automatizados, que rodam em banco de teste isolado em memória). Um rollback local não tem nenhum dado de produção em risco. A correção em `lead_requests` também não afeta nenhum dado real: nenhuma proposta real foi convertida nesta sessão, apenas propostas fictícias de teste.

## Se algo já estiver em uso quando uma fase futura precisar reverter

A partir da Fase 6 (dashboard/relatórios), um rollback de schema com dados reais já inseridos deve seguir a mesma cautela já documentada para a migration 0005 de parceiros: parar escritas, tirar um dump de evidência antes de reverter, e decidir explicitamente se os dados existentes devem ser preservados fora das tabelas antes do `DROP`. As Fases 1–5 não têm esse risco porque nenhum dado real foi criado — apenas dados fictícios de teste, em banco isolado em memória.

## Pendência registrada para antes de qualquer publicação real

A proteção contra saldo negativo de milhas sob concorrência real só está comprovada para o runtime Node/Postgres (`tests/mileage-allocation-concurrency.pg-real.test.ts`, gated, não executado nesta sessão por falta de um Postgres real disponível). O Worker/D1 usa uma checagem sequencial sem lock real — antes de publicar o Worker em produção com o módulo financeiro ativo, uma solução específica para D1 (ou uma decisão documentada de aceitar o risco, com mitigação operacional) precisa ser resolvida por quem for autorizar a publicação. Esta era a única pendência técnica endereçável pela Fase 7 (consolidação) que permanece deliberadamente em aberto, porque resolvê-la de verdade exige acesso a um Postgres real (para a prova de concorrência) e uma decisão de arquitetura/negócio sobre o Worker que está fora do escopo técnico desta tarefa.
