# Operação — módulo financeiro (estado após Fase 6)

## Como rodar localmente

Mesmos passos do `README.md` do projeto, sem nenhuma variável nova:

1. `.env` com `EMAIL_MODE=capture` e `PAYMENTS_MODE=disabled` (padrão já usado por todo o projeto).
2. `docker compose up -d db`
3. `pnpm install --frozen-lockfile`
4. `pnpm db:migrate` (aplica também `0009_finance_foundation.sql`)
5. `pnpm dev`
6. Entrar com uma conta `master` (convite via `/api/admin/bootstrap/master-invites` ou `/api/admin/master-invites`, como já documentado) e abrir `/financeiro.html` (ou o botão "Abrir Financeiro" em `/admin.html`).

Para o Worker/D1: `pnpm d1:migrate:local` aplica a mesma migração 0009 no D1 local; `pnpm worker:dev` sobe o Worker localmente.

## O que existe hoje (Fases 1, 2, 3, 4, 5 e 6)

- Fase 1: centros de custo, categorias (receita/custo direto/despesa operacional, hierárquicas), contas financeiras internas e contrapartes — CRUD completo, sempre `master`-only, nunca `DELETE` (apenas `active=false`).
- Fase 2: assinaturas recorrentes (com histórico de reajuste e máquina de estado trial/active/suspended/canceled/ended), geração idempotente de cobrança por período (`POST /api/admin/finance/subscriptions/generate-charges`, botão "Gerar cobranças vencidas" em `/financeiro.html`), contas a pagar/despesas avulsas ou geradas por assinatura, pagamento parcial/total, estorno como novo lançamento, cancelamento de obrigação sem pagamento.
- Fase 3: vendas financeiras geradas a partir de uma proposta já convertida na Central de Propostas (nunca duplica, nunca recria a comissão do parceiro), parcelas (contas a receber), recebimento parcial/total, estorno como novo lançamento, cancelamento (sem recebimento) e reembolso (com recebimento) de venda.
- Fase 4: emissões por venda (modo dinheiro/milhas/híbrido/consolidadora/companhia, PNR como referência financeira), custo direto por emissão (8 campos), máquina de estado pendente→emitida→reembolsada (ou pendente→cancelada), custo histórico travado após emitida, lucro bruto e margem calculados no servidor (realizado e projetado) e expostos em `GET /financeiro` → "Emissões e lucro" na lista de vendas.
- Fase 5: compra de lote de milhas (cria automaticamente a obrigação de pagamento ao fornecedor), alocação de milhas para uma emissão (protegida contra saldo negativo — comprovadamente segura sob concorrência real em Node/Postgres, ainda não em Worker/D1), recálculo automático do custo de milhas da emissão a partir das alocações reais, estorno de alocação, cancelamento de lote sem alocação ativa.
- Fase 6: painel "Visão geral" com indicadores por moeda (competência: faturamento/custo direto/lucro bruto/margem/despesas/resultado; caixa: recebido/pago/saldo), painel de alertas (vencidos, próximos vencimentos, assinaturas, margem baixa, milhas com saldo baixo ou vencendo), despesas por categoria, e exportação CSV segura de vendas/contas a pagar/contas a receber.
- Nenhuma integração bancária ou de pagamento real ainda.

## Rotina operacional esperada nesta fase

Depois de cadastrar fornecedor + categoria + assinatura, um master deve clicar em "Gerar cobranças vencidas" periodicamente (não há cron real ativado — geração automática fica para quando o projeto autorizar um agendador real) para que as obrigações de cobrança apareçam em "Contas a pagar e despesas". A geração é idempotente: clicar várias vezes, ou rodar depois de vários períodos sem rodar, nunca duplica cobrança.

Para registrar uma venda: primeiro converter a proposta normalmente pela Central de Propostas existente (`/admin.html`, com `saleAmountCents`/`saleCurrency`), depois em `/financeiro.html` → "Vendas", informar o id dessa proposta para gerar a venda financeira. Depois: adicionar parcelas (a soma nunca pode passar do valor líquido), registrar recebimentos, e só então cancelar (sem recebimento) ou reembolsar (com recebimento) se necessário.

Para registrar o custo de uma emissão: em "Vendas" → "Emissões e lucro", criar a emissão com os custos conhecidos (ainda editáveis), preencher o PNR quando a passagem for realmente emitida e clicar em "emitir" — a partir daí os valores ficam travados e contam como custo realizado no lucro da venda.

Para emissões em milhas ou híbridas: primeiro comprar o lote em "Milhas e fornecedores" (gera a obrigação de pagamento automaticamente), depois, na mesma tela de "Emissões e lucro" da venda, escolher "alocar" e indicar o lote e a quantidade — o custo da emissão é recalculado automaticamente a partir do custo real do lote.

Para acompanhar o resultado do período: abrir "Visão geral" no topo de `/financeiro.html`, escolher o período e o regime (competência ou caixa), e conferir os cartões e a seção "Alertas" logo abaixo. Exportações CSV usam o mesmo período selecionado.

Conciliação bancária completa e relatórios adicionais (ex.: desempenho por parceiro/fornecedor dedicado) ainda não existem — ficam para além da Fase 6, se pedidos.

## Quem pode acessar

Somente contas com papel `master` (mesmo mecanismo de convite único já existente no projeto para o painel administrativo). Não há papel financeiro intermediário nesta fase.

## Plano de backup e restauração (preparado, não executado)

Este módulo não introduz nenhum mecanismo de backup próprio — segue exatamente o mesmo plano já usado pelo resto do banco do site (`docs/DEPLOY_AND_ROLLBACK.md`), porque as tabelas `fin_*` vivem no mesmo Postgres/D1 de tudo o mais.

1. **Antes de qualquer migração em produção** (quando essa etapa for autorizada, o que não aconteceu nesta tarefa): dump completo do banco (`pg_dump`) com timestamp e commit exato registrados, guardado fora do servidor de produção.
2. **Frequência**: mesma política já adotada pelo restante do projeto — este módulo não teve autorização nem motivo para propor uma política de retenção diferente para dados financeiros.
3. **Teste de restauração**: restaurar o dump mais recente em um banco descartável e rodar `pnpm typecheck && pnpm test` contra ele antes de considerar o backup válido — nunca assumir que um dump "provavelmente funciona" sem essa prova.
4. **Escopo financeiro específico**: como nenhuma tabela `fin_*` tem `ON DELETE CASCADE` a partir de `users`/`lead_requests`/`partners` (todas usam `ON DELETE RESTRICT` ou `SET NULL` para preservar histórico), um backup pontual das tabelas `fin_*` isoladamente é tecnicamente possível (`pg_dump -t 'fin_*'`) se um dia for necessário restaurar só o financeiro sem tocar no resto — não testado nesta sessão por não ter sido pedido.
5. **D1**: `wrangler d1 export` (não executado) seria o equivalente para o banco do Worker, seguindo a mesma cadência.

## Plano de staging e rollout (preparado, não executado)

Segue os portões já definidos em `docs/DEPLOY_AND_ROLLBACK.md` para o projeto inteiro, com os itens adicionais específicos do financeiro:

1. Aplicar as migrations `0009`–`0014` em um ambiente de staging com banco vazio ou uma cópia sanitizada (sem dado financeiro real) — nunca em produção diretamente.
2. Rodar a suíte completa (`pnpm typecheck`, `pnpm worker:typecheck`, `pnpm test`, `pnpm build`) contra esse ambiente de staging.
3. **Rodar `tests/mileage-allocation-concurrency.pg-real.test.ts` contra o Postgres real de staging** — esta é a única prova de concorrência real pendente neste projeto; sem ela, a proteção de saldo de milhas sob carga simultânea permanece **NÃO CONFIRMADO** em qualquer ambiente além de uma leitura de código.
4. Validar manualmente em staging, com uma conta `master` de teste: os quatro fluxos ponta a ponta descritos em "Rotina operacional esperada nesta fase" acima.
5. Confirmar que o Worker de staging aponta para o D1 de staging, nunca para o D1 de produção do site público — o financeiro reaproveita o mesmo banco de tudo o mais, então um erro de binding aqui vazaria para o resto do site.
6. Só depois de aprovação explícita de um humano com autoridade sobre produção: planejar a janela de publicação. Esta tarefa não define quem é essa pessoa nem agenda essa janela — isso é uma decisão de negócio fora do escopo técnico desta entrega.
7. **Decisão pendente e explícita antes do passo 6, se o Worker for o runtime publicado**: resolver ou aceitar formalmente o risco de concorrência de alocação de milhas no Worker/D1 (ver `ROLLBACK.md` e `HANDOFF_REVISAO.md`) — não publicar essa lacuna silenciosamente.
