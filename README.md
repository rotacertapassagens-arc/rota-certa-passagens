# Rota Certa Passagens — site público

Implementação local do site público `rotacertapassagens.com`. Este repositório é independente do Rota Certa OS e não deve ser conectado ao painel interno, VPS, n8n, ORC, Radar, Notion operacional, WhatsApp, Metricool ou FinanceHub.

## Estado em 23/09/2026

- Implementado localmente: visual público preservado, API Node/Fastify, Postgres, cadastro com confirmação, sessões revogáveis, recuperação de senha, master por convite, Planner persistente e cobrança Stripe somente sandbox.
- Adicionado em 23/09/2026: programa de indicação de parceiros de ponta a ponta — link rastreável `/i/{codigo}`, atribuição automática/manual no formulário de proposta, gestão de parceiros e comissões no painel master, painel autenticado do próprio parceiro (`/painel-parceiro.html`) sem PII de clientes, página pública de termos (`/parceiros.html`) e outbox de notificações idempotente em modo capture. Paridade mantida entre Node/Fastify+Postgres e Cloudflare Worker+D1. Ver `docs/SECURITY.md` e `docs/openapi.yaml`.
- Iniciado em 24/09/2026, concluído (Fases 1–7) em 25/09/2026: módulo financeiro privado (master-only), em `/financeiro.html`, com paridade Node/Postgres e Worker/D1. Fase 1 (fundação) — categorias, centros de custo, contas financeiras internas e contrapartes. Fase 2 (assinaturas e contas a pagar) — assinaturas recorrentes, geração idempotente de cobrança por período, obrigações com pagamento parcial/total. Fase 3 (vendas e contas a receber) — venda financeira gerada a partir de proposta já convertida (nunca duplica, nunca recria comissão de parceiro), parcelas, recebimento parcial/total; corrigido nesta fase um bug pré-existente que descartava o valor de venda de propostas convertidas sem parceiro. Fase 4 (emissões, custos e lucro) — emissão por venda, custo direto travado após emitida, lucro bruto e margem calculados no servidor. Fase 5 (milhas e fornecedores) — compra de lote (gera obrigação automaticamente), alocação para emissão protegida contra saldo negativo (comprovada sob concorrência real em Node/Postgres; Worker/D1 ainda não — ver `docs/financeiro/ROLLBACK.md`), estorno de alocação. Fase 6 (dashboard e relatórios) — indicadores por moeda em competência e caixa, alertas (vencidos, margem baixa, milhas com saldo baixo), despesas por categoria, exportação CSV segura contra CSV injection. Fase 7 (consolidação) — auditoria real de segurança (94 rotas confirmadas gated) e acessibilidade, índices de performance corrigidos, planos de backup e staging documentados. Ver `docs/financeiro/REQUISITOS.md` para o checklist completo e `docs/financeiro/HANDOFF_REVISAO.md` para os riscos conscientemente pendentes (concorrência de milhas no Worker/D1 e testes que exigem Postgres real/runtime Workers completo).
- Verificado: compilação, checagem de tipos (Node e Worker), testes automatizados (Node) e aplicação local da migração D1.
- Não executado: push, deploy, alteração de DNS/Cloudflare, envio real de e-mail/WhatsApp, cobrança real, criação de contas externas ou ativação de segredos do WhatsApp.
- Referência preservada: o ZIP recebido permanece intacto em `reference/site-original-2026-09-16.zip`.

## Uso local

Requisitos: Node 20+, pnpm e PostgreSQL 17 (o `compose.yaml` oferece apenas o banco, limitado a `127.0.0.1`).

1. Copie `.env.example` para `.env` e troque todos os valores de exemplo.
2. Mantenha `EMAIL_MODE=capture` e `PAYMENTS_MODE=disabled` durante desenvolvimento comum.
3. Inicie o banco: `docker compose up -d db`.
4. Instale dependências: `pnpm install --frozen-lockfile`.
5. Aplique o schema: `pnpm db:migrate`.
6. Inicie o site: `pnpm dev`.

Validação local:

```text
pnpm typecheck
pnpm test
pnpm build
```

## Limites de segurança

- Senhas usam `scrypt`; tokens e códigos são armazenados apenas como hash.
- Sessões usam cookie `HttpOnly`; mutações autenticadas exigem token CSRF e validam a origem.
- As consultas do Planner sempre incluem o usuário proprietário.
- A aplicação rejeita chaves Stripe que não comecem por `sk_test_`.
- O modo de e-mail padrão captura eventos no banco e não envia mensagens reais.
- O primeiro master só nasce por autorização de bootstrap e convite de uso único com expiração.

Consulte `docs/AUDIT_AND_INVENTORY.md`, `docs/SECURITY.md`, `docs/openapi.yaml` e `docs/DEPLOY_AND_ROLLBACK.md` antes de qualquer futura publicação.
