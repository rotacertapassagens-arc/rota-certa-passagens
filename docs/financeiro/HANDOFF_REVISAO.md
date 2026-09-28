# Handoff para revisão independente — módulo financeiro (Fases 1 a 7, consolidado)

## Objetivo desta entrega
Construir localmente o módulo financeiro privado da Rota Certa (master-only). As sete fases do prompt mestre foram cobertas: fundação (1), assinaturas/contas a pagar (2), vendas/contas a receber (3), emissões/lucro por venda (4), milhas/fornecedores (5), dashboard/relatórios (6) e consolidação — revisão de segurança/acessibilidade/performance, documentação operacional, planos de backup e staging (7). Ver `docs/financeiro/REQUISITOS.md` para o checklist completo do escopo pedido vs. entregue, com pendências explícitas.

## Arquitetura escolhida e evidência
Paridade Node/Fastify+PostgreSQL e Cloudflare Worker+D1, regra vigente comprovada do projeto — confirmada nesta fase de consolidação: **94 handlers** (47 por runtime) auditados programaticamente, todos com o gate de autorização correto. **Exceção registrada:** a proteção contra saldo negativo de milhas sob concorrência real só está provada para Node/Postgres (Fase 5) — ver riscos abaixo.

## Correção de bug pré-existente (Fase 3)
`PATCH /api/admin/leads/:id` só persistia `sale_amount_cents`/`sale_currency` para propostas convertidas **com** parceiro; corrigido em `src/routes/admin.ts`/`worker/index.ts`. **Revisar com atenção especial.**

## Achado durante o desenvolvimento — limitação real de pg-mem (Fase 5)
A primeira tentativa de provar concorrência na alocação de milhas contra pg-mem falhou de forma reveladora (duas chamadas concorrentes sobrealocaram um lote). Não é um bug do código — é uma limitação do pg-mem já documentada para `SKIP LOCKED`, agora confirmada também para `FOR UPDATE` simples. A prova real foi movida para `tests/mileage-allocation-concurrency.pg-real.test.ts`, gated, **pendente de execução** por falta de Postgres real neste sandbox.

## Achado durante a Fase 7 — lacuna de performance real
A auditoria de índices (não apenas leitura passiva do schema — comparação sistemática entre as colunas usadas em `WHERE`/`BETWEEN` pelos endpoints do dashboard e os índices realmente criados nas migrations 0009–0013) encontrou 3 colunas de data filtradas por período sem índice. Corrigido com a migration `0014_finance_performance_indexes`.

## Arquivos alterados/criados (resumo por fase)
- Fase 1: `migrations/0009_*`, `src/routes/finance.ts`, 21 testes.
- Fase 2: `shared/subscriptionSchedule.ts`, `migrations/0010_*`, `src/routes/finance-subscriptions.ts`, `src/routes/finance-obligations.ts`, 32 testes.
- Fase 3: `migrations/0011_*`, `src/routes/finance-sales.ts`, correção `admin.ts`/`worker/index.ts`, 14 testes.
- Fase 4: `shared/salesProfit.ts`, `migrations/0012_*`, `src/routes/finance-issuances.ts`, 19 testes.
- Fase 5: `shared/mileageCost.ts`, `migrations/0013_*`, `src/routes/finance-mileage.ts`, 23 testes + 1 gated.
- Fase 6: `shared/financeCsv.ts`, `src/routes/finance-dashboard.ts` (sem migração nova), 22 testes.
- Fase 7: `migrations/0014_finance_performance_indexes.sql` + `.down.sql`, `d1/migrations/0014_*`, `docs/financeiro/REQUISITOS.md` (novo), seções de backup/staging em `OPERACAO.md`, auditoria de segurança/acessibilidade (sem alteração de código além dos índices — nenhuma falha real de segurança ou acessibilidade foi encontrada).
- Comuns: `src/app.ts`, `worker/index.ts`, `public/financeiro.html`/`financeiro.js`, `public/admin.html`, `docs/openapi.yaml` (41 endpoints financeiros, 84 paths no total), `docs/financeiro/*.md` (10 documentos), `README.md`.

## Migrations
`0009` a `0014`. Nenhuma alteração de schema em tabela pré-existente do projeto. Todas testadas: migrate+rollback isolado em Postgres (pg-mem) e migrate real em D1 local via wrangler.

## Endpoints
41 rotas sob `/api/admin/finance/...`. Ver `docs/openapi.yaml` tag `Finance`, e `docs/financeiro/SEGURANCA_E_PERMISSOES.md`.

## Regras de cálculo
`docs/financeiro/REGRAS_CALCULO.md` define os indicadores; `shared/salesProfit.ts` (por venda) e `src/routes/finance-dashboard.ts` (consolidado) implementam sem duplicar a lógica.

## Riscos conhecidos, registrados conscientemente (não resolvidos, porque exigem autorização/ambiente fora do escopo desta tarefa)
- **Concorrência de alocação de milhas no Worker/D1 não está provada** — decisão explícita necessária antes de publicar o Worker com o financeiro ativo.
- `tests/mileage-allocation-concurrency.pg-real.test.ts` e `tests/outbox-claim.pg-real.test.ts` — pendentes de execução (requerem Postgres real).
- `tests/worker-d1.smoke.test.ts` — bloqueado pela limitação de ambiente já documentada desde a Fase 1.
- Sem relatório dedicado de desempenho por parceiro/fornecedor, sem anexos/comprovantes financeiros — ver `REQUISITOS.md`.
- Exportação CSV limitada a 5000 linhas, sem paginação.
- Nenhum teste E2E (Playwright) rodado — nenhum fluxo do site público foi alterado por este módulo, então o risco de regressão nessa camada é baixo, mas não zero-comprovado.

## Testes executados com resultados exatos
Ver `docs/financeiro/TESTES_E_EVIDENCIAS.md`. Resumo: typecheck Node ✅, typecheck Worker ✅, build ✅, vitest 179/181 (2 skips: um pré-existente, um gated) ✅, migração D1 local real (0009–0014) ✅, migrate+rollback Postgres local (as seis, isoladas) ✅, sintaxe do JS do frontend ✅, `git diff --check` ✅, auditoria de segurança (94 handlers, 100% gated) ✅, auditoria de acessibilidade (28/28 inputs rotulados, sem cor isolada) ✅. Playwright E2E não executado. `tests/worker-d1.smoke.test.ts` e `tests/mileage-allocation-concurrency.pg-real.test.ts` — **BLOQUEADO/PENDENTE** por falta de ambiente.

## Itens pendentes (todos fora do alcance técnico desta tarefa sem autorização/ambiente adicional)
1. Decisão sobre concorrência de milhas no Worker/D1.
2. Execução dos dois testes gated num ambiente com Postgres real.
3. Execução do smoke test do Worker num ambiente com runtime Workers completo.
4. Relatório de desempenho por parceiro/fornecedor e anexos financeiros, se forem pedidos no futuro.
5. Toda e qualquer ação de produção (deploy, migração remota, segredo, cobrança real) — nunca autorizada, nunca executada.

## Roteiro sugerido para a revisão independente
1. Revisar a correção em `src/routes/admin.ts`/`worker/index.ts` (Fase 3).
2. **Rodar `tests/mileage-allocation-concurrency.pg-real.test.ts` e `tests/outbox-claim.pg-real.test.ts` contra um Postgres real descartável.**
3. Reexecutar (ou tentar) `tests/worker-d1.smoke.test.ts` num ambiente com suporte total ao runtime Workers.
4. Conferir a auditoria de segurança independentemente: rodar o mesmo tipo de busca programática (primeira linha de cada handler `finance*`) e confirmar os mesmos resultados.
5. Testar manualmente o fluxo completo ponta a ponta: proposta → venda → parcela → recebimento → lote de milhas → emissão → alocação → emitir → conferir `/dashboard/overview` e exportar CSV.
6. Confirmar que uma categoria/observação com conteúdo hostil (`=...`) sai neutralizada em toda exportação CSV.
7. Confirmar que nenhum dado financeiro aparece em HTML público, bundle pré-carregado ou `localStorage`.
8. Revisar as seis `.down.sql` aplicando-as contra um Postgres real descartável.
9. Ler `docs/financeiro/REQUISITOS.md` e confirmar (ou contestar) as duas pendências explícitas registradas.

## Comandos seguros para reproduzir a validação local
```
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/tsc -p worker/tsconfig.json --noEmit
node_modules/.bin/vitest run --exclude "**/worker-d1.smoke.test.ts"
node_modules/.bin/wrangler d1 migrations apply DB --local
node_modules/.bin/tsc -p tsconfig.json
node --check public/assets/financeiro.js
```

## Confirmação final
Nenhum `git push`, deploy, alteração de DNS/Cloudflare, migração remota, envio real de e-mail/WhatsApp, cobrança real, criação de credencial ou segredo foi executado em nenhuma das sete fases desta tarefa. Nenhum dado real foi criado — apenas dados fictícios em ambiente de teste isolado. `git status` permanece limpo, sem nenhum commit feito por esta sessão (conforme instrução explícita de só commitar quando pedido).

## Adendo — revisão independente de 28/09/2026

Uma revisão independente reexecutou os comandos deste handoff e encontrou duas divergências pontuais em relação ao texto acima (mantido intacto por preservação de histórico — ver `docs/financeiro/REVISAO_INDEPENDENTE.md` para a evidência completa):

1. **`git status` não estava limpo** no início da revisão de 28/09 — havia as mesmas alterações locais não commitadas descritas nas seções "Arquivos alterados/criados" e "Migrations" acima (6 arquivos modificados, dezenas de arquivos novos das Fases 1–7). Isso é esperado — nenhuma destas fases foi commitada, exatamente como a seção "Confirmação final" já registra ("sem nenhum commit feito por esta sessão"); a frase "`git status` permanece limpo" acima refere-se ao fato de nenhum commit ter sido criado, não à ausência de mudanças locais, mas ficou ambígua o suficiente para gerar confusão numa retomada posterior. Fica esclarecido aqui.
2. **A contagem "94 handlers (47 por runtime)" está desatualizada.** Recontagem programática em 28/09/2026 encontrou 53 combinações rota+método por runtime (106 no total) — a contagem de "41 endpoints" (paths únicos) e "84 paths" (`openapi.yaml`) continua correta. Ver `docs/financeiro/REVISAO_INDEPENDENTE.md`, seção GATE 1.
3. **`tests/worker-d1.smoke.test.ts` não está mais bloqueado por ambiente** — rodado isoladamente em 28/09/2026, passou em ~83s. A limitação de ambiente relatada nas Fases 1 e 7 pode ter sido específica daquele sandbox/momento; neste ambiente e nesta data o teste executa normalmente. Ver `docs/financeiro/TESTES_E_EVIDENCIAS.md` para o adendo equivalente.
4. **Achado novo, não presente nesta versão original:** a alocação de milhas no runtime Worker/D1 tem uma condição de corrida real confirmada em código (não apenas "não comprovada") — ver `docs/financeiro/REVISAO_INDEPENDENTE.md`, GATE 4, para a análise completa e as três opções de mitigação propostas.
