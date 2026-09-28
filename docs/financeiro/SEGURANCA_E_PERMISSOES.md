# Segurança e permissões — módulo financeiro

## Regra única e inegociável
Toda rota sob `/api/admin/finance/...`, sem exceção — incluindo GET, relatórios e exportações — passa por:
1. `requireAuth` (Node) / `requireMaster`-equivalente (Worker): sem sessão válida → **401** `authentication_required`.
2. Checagem de papel `master` em `roles`: sessão válida sem papel master → **403** `forbidden`.
3. Mutações (`POST`/`PATCH`): adicionalmente `requireMutationAuth` — valida `Origin === APP_ORIGIN` e o hash do token CSRF contra `sessions.csrf_token_hash`. Sem isso → 403 (`origin_rejected`/`csrf_rejected`).

Isto reaproveita literalmente `src/auth.ts` (`requireAuth`, `requireMutationAuth`) e o equivalente já existente em `worker/index.ts` (`requireMaster`, `getAuth`) — nenhuma nova primitiva de autenticação é criada.

## O que nunca acontece
- Nenhuma rota financeira decide autorização no cliente (esconder botão). O padrão já comprovado em `admin.js:51-62` mostra que a UI só aparece depois de um 200 real do servidor — `financeiro.js` segue o mesmo padrão.
- Nenhum dado financeiro entra no HTML público, no bundle pré-carregado, em cache público ou em `localStorage`/`sessionStorage`.
- Nenhum segredo, chave ou token no frontend.
- Nenhum `DELETE` de linha financeira com potencial histórico — sempre `active=false`, cancelamento ou estorno auditado.
- Nenhuma rota confia em ID adivinhado: toda consulta de detalhe é filtrada por chave primária + checagem de que o recurso pertence ao domínio financeiro (não há "dono" individual como no Planner, pois é um painel único de empresa — mas isso não abre exceção nenhuma ao gate `master`).

## Auditoria
Toda mutação financeira chama `audit(db, config, request, action, actorUserId, targetType, targetId, metadata)`, o mesmo helper já usado por `admin.ts`/`partners.ts`. Ações da Fase 1: `finance.category_created`, `finance.category_updated`, `finance.cost_center_created/updated`, `finance.account_created/updated`, `finance.counterparty_created/updated`. Ações da Fase 2: `finance.subscription_created/updated/repriced/status_changed`, `finance.subscription_charges_generated`, `finance.obligation_created/updated/canceled`, `finance.obligation_payment_created`, `finance.obligation_payment_reversed`. Ações da Fase 3: `finance.sale_created`, `finance.sale_canceled`, `finance.sale_refunded`, `finance.receivables_created`, `finance.receivable_payment_created`, `finance.receivable_payment_reversed`. Ações da Fase 4: `finance.issuance_created/updated/issued/canceled/refunded`. Ações da Fase 5: `finance.mileage_lot_created/canceled`, `finance.mileage_allocation_created/voided`. Metadata nunca inclui segredo, cookie, token ou dado bancário completo — só um resumo seguro da mudança (ex.: campo alterado + novo valor, nunca dump do registro inteiro quando ele puder conter dado sensível).

## Regras de negócio que também são controles de segurança/integridade (Fase 2)
- Cancelamento de obrigação só é aceito com `status='open'` (checado no servidor, ignorando qualquer status enviado pelo cliente): uma obrigação com pagamento não pode ser cancelada por engano sem primeiro estornar cada pagamento individualmente.
- Um pagamento só pode ser estornado uma vez — garantido por índice único parcial no banco (`fin_obligation_payments_reversal_unique_idx`), não apenas por uma checagem de aplicação que poderia perder uma corrida.
- A moeda do pagamento é sempre validada contra a moeda da obrigação no servidor antes de gravar — o cliente nunca decide isso.
- `POST /generate-charges` é idempotente por design (`idempotency_key` única por assinatura+período): repetir a chamada, inclusive concorrentemente, nunca duplica uma obrigação já gerada.

## Regras de negócio que também são controles de segurança/integridade (Fase 3)
- `POST /sales/from-lead/{leadRequestId}` nunca aceita um valor de venda vindo do cliente — sempre lê `sale_amount_cents`/`sale_currency` de `lead_requests`, que só um master preenche via o fluxo já auditado de conversão de proposta. O `discountCents` é o único valor aceito do cliente nesta rota, e é validado contra o valor bruto (nunca pode zerar ou inverter o valor líquido).
- Uma venda só pode ser cancelada com zero recebimentos, e só pode ser reembolsada com pelo menos um recebimento líquido positivo — o servidor decide qual dos dois é permitido, nunca o cliente.
- A soma das parcelas ativas de uma venda nunca pode ultrapassar `net_amount_cents`, validado no servidor a cada criação de parcela (considerando o que já existe, não apenas o lote atual).
- Um recebimento só pode ser estornado uma vez — mesmo padrão de índice único parcial já usado nas obrigações (`fin_receivable_payments_reversal_unique_idx`).
- `fin_sales` nunca escreve em `lead_requests` nem em `partner_commissions` — é estritamente somente leitura dessas tabelas, preservando toda a auditoria e as regras de comissão já existentes e testadas.

## Regras de negócio que também são controles de segurança/integridade (Fase 4)
- Nenhuma emissão pode ser criada para uma venda que não esteja `confirmed`, e a moeda da emissão é sempre validada contra a moeda da venda no servidor — o cliente nunca escolhe a moeda livremente nem consegue produzir um lucro calculado misturando moedas.
- Uma emissão `issued` nunca pode ser editada de volta (`PATCH` retorna 409 `issuance_locked_after_issued`) — o custo histórico de uma emissão já comprometida é imutável, só a máquina de estado (`issue`/`cancel`/`refund`) pode mudar seu status daí em diante.
- `lucro`/`margem` são sempre calculados no servidor (`shared/salesProfit.ts`) a partir da soma de custos das emissões — o cliente nunca envia um valor de lucro pronto.

## Regras de negócio que também são controles de segurança/integridade (Fase 5)
- Saldo de um lote de milhas nunca pode ficar negativo, mesmo sob concorrência real (Node/Postgres): a alocação lê o saldo com `SELECT ... FOR UPDATE` no lote dentro da mesma transação do `INSERT` da alocação — provado por teste real de concorrência (`tests/mileage-allocation-concurrency.pg-real.test.ts`, gated). **No runtime Worker/D1 essa proteção é apenas best-effort** (sem lock real, D1 não oferece transação interativa) — lacuna conhecida e documentada, não uma alegação de segurança comprovada; ver `PLANO_IMPLEMENTACAO.md`.
- O custo de cada alocação é calculado com `BigInt` (nunca `float`), congelado no momento da criação; editar o lote depois nunca reprecifica uma alocação já criada.
- Toda compra de lote cria automaticamente sua obrigação de pagamento na mesma transação — nunca é possível criar um lote sem o registro correspondente do que é devido ao fornecedor.
- Um lote com alocação ativa nunca pode ser cancelado, e não existe nenhum endpoint de `DELETE` para lote nem para alocação — cancelamento e estorno são os únicos caminhos, sempre auditados.
- Alocação só é aceita enquanto a emissão está `pending` — a mesma trava de custo histórico da Fase 4 se estende às milhas: depois de emitida, nem o custo em dinheiro nem a quantidade/custo de milhas podem mudar.

## Regras de negócio que também são controles de segurança/integridade (Fase 6)
- Todo indicador do dashboard é calculado no servidor a partir de linhas persistidas — o endpoint de visão geral nunca aceita um total pronto do cliente, e o regime (caixa/competência) é sempre explícito na resposta, nunca ambíguo.
- Exportação CSV é protegida contra "CSV injection" (`shared/financeCsv.ts`): qualquer célula que comece com `=`, `+`, `-`, `@`, tab ou CR — inclusive vindo de texto livre digitado por um operador, como nome de categoria ou observação — recebe um apóstrofo à frente antes de sair do servidor, neutralizando a interpretação como fórmula por Excel/Sheets. Testado ponta a ponta com uma categoria hostil real, não só na função pura.
- Exportação é limitada a 5000 linhas por chamada — não existe endpoint de exportação sem limite.
- Todas as rotas de dashboard são somente leitura (`GET`) — mesmo gate de 401/403 das demais rotas financeiras, sem exigir CSRF (mutações não se aplicam aqui).

## Anexos (fases futuras)
Comprovantes financeiros: apenas metadados locais nesta fase (nome do arquivo, tipo, tamanho, hash) — nenhuma URL pública permanente é criada. Validação de extensão/tamanho/tipo acontece antes de qualquer aceitação, mesmo que o upload real do binário seja implementado depois.

## Testes obrigatórios por rota nova
Para cada endpoint financeiro: (1) sem cookie de sessão → 401; (2) sessão de usuário `customer` → 403; (3) sessão `master` sem CSRF em mutação → 403; (4) sessão `master` com CSRF válido → sucesso; (5) tentativa de adivinhar/forjar um id de outra entidade não vaza dado nem contorna a regra. Ver `tests/finance.test.ts`.

## Rate limit
Não aplicado por padrão às rotas master (uso interno, autenticado, de baixo volume) — mesmo critério já adotado pelas rotas `/api/admin/*` existentes, que não usam `enforceRateLimit`. Reavaliar se uma rota de exportação em massa for adicionada em fase futura.
