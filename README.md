# Rota Certa Passagens — site público

Implementação local do site público `rotacertapassagens.com`. Este repositório é independente do Rota Certa OS e não deve ser conectado ao painel interno, VPS, n8n, ORC, Radar, Notion operacional, WhatsApp, Metricool ou FinanceHub.

## Estado em 17/09/2026

- Implementado localmente: visual público preservado, API Node/Fastify, Postgres, cadastro com confirmação, sessões revogáveis, recuperação de senha, master por convite, Planner persistente e cobrança Stripe somente sandbox.
- Verificado: compilação, checagem de tipos e testes automatizados.
- Não executado: push, deploy, alteração de DNS/Cloudflare, envio real de e-mail, cobrança real ou criação de contas externas.
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
