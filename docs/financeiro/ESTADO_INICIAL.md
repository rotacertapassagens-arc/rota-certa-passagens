# Estado inicial — auditoria antes do módulo financeiro

Data da auditoria: 24/09/2026. Modo somente leitura, feita antes de qualquer edição para o módulo financeiro. Repositório: `C:\Users\usuario05\Documents\Carlos\Claude\rota-certa-site`. Branch no momento da auditoria: `feat/partner-privacy-tiered-commission-2026-09-24` (limpa, sem alterações pendentes — `git status --short` vazio).

Rótulos usados abaixo: **CONFIRMADO** (visto no código/migrations), **TESTADO_LOCALMENTE** (há teste automatizado cobrindo), **CONFIGURADO_NAO_TESTADO**, **NÃO CONFIRMADO**.

## 1. Runtimes e persistência

- **CONFIRMADO** — dois backends mantidos em paridade deliberada: Node/Fastify + PostgreSQL (`src/`) e Cloudflare Worker + D1 (`worker/index.ts`, um único arquivo denso, 1090 linhas).
- **CONFIRMADO** — migrations pareadas: `migrations/0001..0008` (Postgres, com `.down.sql`) e `d1/migrations/0001..0008` (D1, sem rollback automático nativo). O README (23/09/2026) declara explicitamente: *"Paridade mantida entre Node/Fastify+Postgres e Cloudflare Worker+D1"* — isto é a regra vigente do projeto, não uma preferência minha.
- **TESTADO_LOCALMENTE** — `tests/worker-d1.smoke.test.ts` prova paridade básica do Worker/D1; suíte padrão Node roda contra `pg-mem` (não Postgres real). Há um teste gated à parte para provas que dependem de comportamento real de Postgres (`tests/outbox-claim.pg-real.test.ts`, `ROTA_CERTA_TEST_REAL_PG_URL`, não executado por `pnpm test`).
- **Decisão para o módulo financeiro:** por haver regra vigente comprovada de paridade, o módulo financeiro será implementado nos dois runtimes, com migrations e rotas equivalentes. Não há ambiguidade que justifique feature flag por incerteza de runtime.

## 2. Autenticação, sessão, autorização

- **CONFIRMADO** — `src/auth.ts`: sessão opaca em cookie `HttpOnly` (`__Host-rc_session` em produção), cookie CSRF separado (`rc_csrf`, legível por JS, `SameSite=Strict`), `requireAuth` (401 sem sessão), `requireMutationAuth` (401/403 + valida `Origin` contra `APP_ORIGIN` + compara hash do CSRF). Papéis em `user_roles` (`customer`, `master`, e agora `partner`, adicionado na migration 0005).
- **CONFIRMADO** — padrão de gate master: `requireMaster()` (definido em `src/routes/admin.ts:385`, repetido localmente em `src/routes/partners.ts` e `worker/index.ts:414`) — `requireAuth` primeiro, depois checa `roles.includes('master')`, senão 403.
- **TESTADO_LOCALMENTE** — `tests/security.test.ts`, `tests/partners.test.ts`, `tests/app.test.ts` cobrem 401/403, CSRF, isolamento por `owner_user_id`/`partners.user_id=sessão`.
- **CONFIRMADO** — senha via `scrypt`; tokens/códigos só como hash (`tokenDigest` com pepper); rate limit persistido (`rate_limit_buckets`, transacional, `FOR UPDATE`); auditoria (`audit_events`: ator, ação, tipo/id do alvo, `ip_hash`, metadata jsonb, timestamp) já em uso extensivo no fluxo de parceiros/comissões.
- **Reuso confirmado para o financeiro:** `requireAuth`, `requireMutationAuth`, `audit()`, `enforceRateLimit()`, `isValidCurrency()`/`ALLOWED_CURRENCIES` (`EUR`,`USD`,`BRL`,`GBP` — já cobre os dois exigidos pelo prompt), `isUniqueViolation()`. Não será recriada nenhuma dessas peças.

## 3. Dinheiro, moeda e padrões já adotados que o financeiro deve seguir

- **CONFIRMADO** — dinheiro sempre inteiro em centavos (`amount_cents`, `price_cents` etc.), nunca `float`, em todas as tabelas existentes (`payments`, `plans`, `partner_commissions`, `lead_requests.sale_amount_cents`).
- **CONFIRMADO** — percentuais em pontos-base (`commission_percentage_bps`, 1% = 100 bps) — mesmo padrão que será reaproveitado para categorias/margens do financeiro.
- **CONFIRMADO** — snapshot histórico já é padrão do projeto: `partner_commissions` congela `commission_type_snapshot`, `commission_rate_snapshot`, `sale_amount_cents_snapshot`, `commission_policy_snapshot` (jsonb) no momento da criação; edição posterior da regra global nunca reprecifica histórico. Este é exatamente o princípio exigido pela seção 8 do prompt para custo de milhas/emissões — será reaplicado, não reinventado.
- **CONFIRMADO** — estado "ativo/nunca apagar" já é o padrão para `partners` (`active` boolean, sem hard delete) e para comissão (`status` com `void` + `void_reason` + `voided_at`/`voided_by`, nunca `DELETE`).

## 4. Parceiros e comissão existentes (não duplicar)

- **CONFIRMADO** — `partners` (link de indicação, comissão fixa/percentual, moeda própria), `partner_commissions` (com máquina de estado `pending→approved→paid`, mais `void`), `referral_clicks`, `notification_outbox` (idempotente, `idempotency_key` único), `lead_requests` estendida com `partner_id`, `sale_amount_cents`, `sale_currency`, `converted_at`.
- **Distinção obrigatória para o financeiro:** `partners` é o parceiro de **indicação** (afiliado que traz cliente, ganha comissão sobre venda). O prompt pede uma entidade separada de **fornecedor/contraparte financeira** (fornecedor de milhas, consolidadora, companhia aérea). São conceitos e tabelas diferentes — o financeiro criará `fin_counterparties` com seu próprio `kind`, e uma pessoa poderá aparecer nas duas tabelas sem misturar lançamentos. Não vou modificar `partners`/`partner_commissions`.
- Este programa de parceiros continua ativo, tem UI própria (`painel-parceiro.html`, seção "Parceiros" em `admin.html`) e testes E2E (`tests/e2e/partner-flow.spec.ts`) — não deve regredir.

## 5. Estrutura de dados existente relevante

Tabelas confirmadas em `migrations/0001_initial.sql` a `0008_partner_privacy_and_tiered_commission.sql`: `users`, `profiles`, `user_roles`, `sessions`, `account_tokens`, `plans`, `subscriptions` (assinatura de **acesso ao produto do cliente**, não confundir com "assinaturas/despesas recorrentes da empresa" pedidas no prompt — são domínios diferentes; o financeiro não reaproveita esta tabela), `payments` (pagamento do cliente à Rota Certa pelo plano, via Stripe sandbox — também não é o mesmo domínio de "contas a pagar/receber" do financeiro), `webhook_events`, `email_events`, `lead_requests` (proposta de voo — **será referenciada, não duplicada**, pela futura entidade de venda), `trips`/`itinerary_items`/`places`/`reservations`/`trip_links`/`trip_notes`/`budgets`/`checklist_items` (Planner do cliente, domínio isolado por `owner_user_id`, fora de escopo), `rate_limit_buckets`, `audit_events`.

**Atenção de nomenclatura:** já existe uma tabela `expenses` (gasto de viagem do cliente no Planner, filtrada por `owner_user_id`) e uma tabela/coluna `budgets`. O módulo financeiro da empresa usará prefixo `fin_` em todas as tabelas novas (`fin_accounts`, `fin_categories`, `fin_counterparties`, `fin_subscriptions`, `fin_sales`, `fin_receivables`, `fin_obligations`, `fin_issuances`, `fin_mileage_lots`, `fin_mileage_allocations`) para eliminar qualquer ambiguidade com o domínio do cliente/Planner.

## 6. Persistência sensível no cliente

- **CONFIRMADO — sem persistência inadequada em `localStorage`.** Busca em `public/**/*.js` e `public/**/*.html` não encontrou uso de `localStorage`/`sessionStorage` para sessão, senha ou dado financeiro; `admin.js` usa exclusivamente cookie `HttpOnly` de sessão + leitura do cookie CSRF (não sensível, feito para o header exigido) e chamadas `fetch` autenticadas por cookie. Toda decisão de exibição de UI master depende da resposta 401/403 do servidor (`admin.js:51-62`), nunca de um estado guardado no navegador.

## 7. Testes, build e scripts existentes

- **CONFIRMADO** (`package.json`): `pnpm typecheck` (tsc Node), `pnpm worker:typecheck` (tsc Worker), `pnpm test` (vitest contra pg-mem), `pnpm test:e2e` (Playwright), `pnpm build`, `pnpm db:migrate`/`db:rollback` (Node cli), `pnpm d1:migrate:local`/`:remote` (wrangler).
- **TESTADO_LOCALMENTE** conforme README: compilação, typecheck (Node e Worker), testes automatizados Node, aplicação local da migração D1. Push, deploy, DNS/Cloudflare, e-mail/WhatsApp real, cobrança real: **NÃO AUTORIZADO / NÃO EXECUTADO**, e este projeto financeiro mantém a mesma restrição.

## 8. Limites confirmados para esta tarefa

- Este repositório é `rota-certa-site` (site público). `rota-certa-os` (cockpit operacional) e o FinanceHub pessoal/comercial do usuário são projetos totalmente separados, não tocados, não lidos, não copiados nesta tarefa.
- Nenhuma credencial real, chave, e-mail/telefone real ou valor real será usado; `.env.example` continua com placeholders; `EMAIL_MODE=capture` e `PAYMENTS_MODE=disabled`/sandbox permanecem como estão.

## 9. Conclusão da Fase 0

Nenhum conflito entre trabalho local pendente do usuário e esta tarefa (árvore limpa). Base de reuso é sólida e extensa (auth, CSRF, auditoria, idempotência, dinheiro em centavos, snapshot histórico, paridade dual-runtime) — o módulo financeiro deve seguir esses padrões byte a byte, não introduzir um estilo novo. Prossegue-se para a Fase 1 conforme `PLANO_IMPLEMENTACAO.md`.
