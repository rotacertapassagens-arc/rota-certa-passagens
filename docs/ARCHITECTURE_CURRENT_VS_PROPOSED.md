# Arquitetura: atual vs. proposta — rotacertapassagens.com

> Escopo: apenas o site público `rotacertapassagens.com`. Este documento
> **não** trata do "Rota Certa OS" (painel interno de operações, VPS
> `144.91.93.68`) — são projetos independentes.

Data do levantamento: 2026-09-16 (reconfirmado com evidência fresca; ver
`backup-publicado-2026-09-16/SNAPSHOT_INFO.md`).

## 1. Arquitetura atual (confirmada por evidência)

- **Frontend:** um único arquivo HTML (`site-atual.html`, ~343 KB) com CSS e
  JS inline, sem framework (não é React/Vue/Next — HTML+JS puro manipulando o
  DOM diretamente). Imagens embutidas como `data:` URI em Base64 dentro do
  próprio HTML.
- **Hospedagem:** Cloudflare (confirmado por `Server: cloudflare` no header
  HTTP e pelos registros DNS `A`/`AAAA` apontando para IPs da Cloudflare:
  `172.67.144.234`, `104.21.10.76`, `2606:4700:3030::ac43:90ea`,
  `2606:4700:3035::6815:a4c`).
- **`www` não configurado:** `https://www.rotacertapassagens.com` não
  responde — só o domínio raiz está ativo.
- **E-mail (domínio) não configurado:** nenhum registro `MX`, `TXT` (SPF) no
  root, `TXT` em `_dmarc.rotacertapassagens.com` (DMARC), nem em
  `default._domainkey.rotacertapassagens.com` (DKIM). O domínio não consegue
  hoje enviar e-mail transacional autenticado de forma confiável.
- **"Login" e "Planner":** inteiramente client-side via `localStorage` do
  navegador. A "senha" é guardada em texto puro no `localStorage`, sem
  nenhum servidor validando nada — qualquer pessoa com acesso ao
  DevTools do navegador lê ou altera os dados. Não há isolamento real entre
  usuários: é por navegador/dispositivo, não por conta de fato.
- **Endpoints de API "fantasma":** o JS do site já referencia `fetch()` para
  `/api/geo`, `/api/lead`, `/api/send-code`, `/api/verify-code` — mas nenhum
  desses existe de fato; todos retornam `404` (reconfirmado nesta auditoria).
  Ou seja, o fluxo de cadastro/confirmação por e-mail já está desenhado no
  frontend, mas nunca foi implantado no backend.
- **Pagamentos:** **nenhum provedor de pagamento é referenciado em lugar
  nenhum do código** (busca explícita por Stripe, PayPal, Mercado Pago,
  PagSeguro, Checkout.com, Adyen, Braintree, e por termos como
  "checkout"/"billing"/"subscription"/"pricing" — zero ocorrências
  relevantes; a única palavra parecida encontrada foi "plano" num texto
  comum sobre o Planner gratuito, sem relação com cobrança). Isso confirma a
  auditoria anterior: não há nenhuma integração de pagamento, sandbox ou
  produção, para desmontar ou migrar.
- **Backend real:** não existe. Não há banco de dados, não há servidor de
  aplicação, não há sessão de servidor, não há hashing de senha.

### Resumo visual do estado atual

```
Visitante → Cloudflare (DNS + edge) → HTML/CSS/JS estático único
                                          │
                                          ├─ "Login"/"Planner" → localStorage do navegador
                                          │                      (senha em texto puro, sem servidor)
                                          │
                                          └─ fetch() para /api/geo, /api/lead,
                                             /api/send-code, /api/verify-code
                                             → 404 (nunca implantados)

Sem MX/SPF/DKIM/DMARC → domínio não envia e-mail transacional
Sem www configurado
Sem provedor de pagamento em lugar nenhum
```

## 2. Arquitetura proposta (alto nível, recomendação — não compromisso definitivo)

> Importante: **não construir nada disto ainda.** Os arquivos com o
> visual/funcionalidade real (enviados pela namorada do dono do projeto) são
> a referência principal para a reconstrução do frontend, e ainda não
> chegaram nesta máquina (ver seção "pendências" no relatório final). Esta
> seção é só o plano técnico de backend/infraestrutura para quando esses
> arquivos chegarem.

### 2.1 Usuários, papéis e permissões

- **Usuário master (dono/operador da Rota Certa):** acesso administrativo —
  gerencia clientes, planos, conteúdo do Planner, vê métricas agregadas.
- **Cliente (assinante):** acesso apenas aos próprios dados isolados
  (Planner pessoal, plano contratado, histórico de pagamento).
- Modelo simples de papéis (`role`): `admin` e `customer` é suficiente para
  o volume atual — não recomendo RBAC complexo agora (over-engineering para
  o estágio do produto). Cada registro de dado do cliente (ex.: itens do
  Planner) carrega um `user_id` de dono e todas as queries filtram por ele
  (isolamento por linha, não por schema separado — mais barato de operar).

### 2.2 Banco de dados real

Duas opções concretas e baratas, sem compromisso definitivo — a escolha
final depende do volume esperado de usuários pagantes quando o backend for
construído:

1. **Postgres gerenciado (Supabase ou Neon)** — recomendação por padrão.
   - Free tier cobre o estágio inicial; escala sem trocar de tecnologia.
   - Supabase já entrega Auth, Row Level Security e Storage prontos, o que
     reduz bastante código de autenticação/isolamento por cliente escrito à
     mão — atraente dado que o time é pequeno.
   - Neon é mais "Postgres puro gerenciado", sem os extras de Auth/Storage
     do Supabase — faz sentido se o backend for feito em Node/Next.js com
     auth própria (via NextAuth/Lucia, por exemplo) e não se quiser
     depender de mais uma plataforma.
2. **SQLite + Litestream** — alternativa mais barata ainda, viável apenas se
   o volume de clientes pagantes for baixo (dezenas/poucas centenas) e não
   houver necessidade de múltiplas instâncias de servidor escrevendo ao
   mesmo tempo. Litestream replica o arquivo SQLite continuamente para
   armazenamento em nuvem (ex. S3/R2) como backup/DR. Mais simples de
   operar no início, mas menos folga para crescer sem migração depois.

**Tabelas mínimas propostas** (independente da opção escolhida):
`users`, `sessions`, `password_resets`, `plans`, `subscriptions`,
`payments`, `planner_items` (substituindo o `localStorage` atual, com
`user_id` obrigatório em cada linha).

### 2.3 Autenticação real

- Hash de senha com `bcrypt` ou `argon2` (nunca texto puro, ao contrário do
  `localStorage` atual).
- Confirmação de e-mail obrigatória no cadastro (usando os eventos de
  Resend descritos abaixo) antes de liberar acesso completo.
- Sessão segura: cookie de sessão `HttpOnly`, `Secure`, `SameSite=Lax` (ou
  `Strict` onde não quebrar o fluxo de link de e-mail), token opaco ou JWT
  de vida curta com refresh — não guardar sessão em `localStorage`.
- Recuperação de senha via link de uso único com expiração curta
  (ex. 30-60 min), invalidado após uso.
2. Rate limiting nos endpoints sensíveis (`/api/send-code`,
   `/api/verify-code`, login, recuperação de senha) para conter força bruta
   e abuso — por IP e por conta.
- Proteção CSRF nos endpoints que mudam estado via formulário/cookie de
  sessão (token CSRF de dupla submissão ou `SameSite` estrito combinado com
  checagem de origem).
- Resolve também o problema real hoje: os endpoints `/api/*` já "existem" no
  JS do frontend mas são 404 — a implementação real precisa nascer com essas
  proteções desde o primeiro dia, não como retrofit.

### 2.4 E-mail transacional (Resend)

Pré-requisito: configurar corretamente **SPF, DKIM e DMARC** no DNS do
domínio (hoje ausentes — confirmado nesta auditoria), senão os e-mails via
Resend caem em spam ou são rejeitados. `www` não é bloqueante para isso, mas
vale configurar junto.

Eventos mínimos a cobrir:
- Confirmação de cadastro (double opt-in)
- Boas-vindas (pós-confirmação)
- Recuperação de senha
- Pagamento aprovado
- Pagamento recusado
- Assinatura cancelada
- Trial acabando (aviso alguns dias antes do fim dos 10 dias grátis)
- Acesso expirado (fim do trial ou assinatura sem renovação)

### 2.5 Pagamentos (camada desacoplada de um único provedor)

- **Nenhum provedor está integrado hoje** (reconfirmado nesta auditoria) —
  ponto de partida limpo, sem nada para migrar ou desmontar.
- Recomendação: desenhar uma interface interna de pagamento
  (`createCheckoutSession`, `handleWebhook`, `cancelSubscription`, etc.) que
  não vaze detalhes do provedor específico para o resto do backend — troca
  de provedor no futuro não deveria exigir reescrever regras de negócio.
- Provedor recomendado para começar: **Stripe Checkout + Billing**, em modo
  **sandbox/teste** (nunca produção/cobrança real nesta fase).
- Planos propostos (a validar com o dono do projeto antes de configurar no
  Stripe):
  - **Grátis:** 10 dias de acesso ao Planner.
  - **Planner:** €9,99 / 30 dias.
  - **Personalizado:** a partir de €49,99 — **sem cobrança automática** até
    o escopo ser confirmado manualmente com o cliente (ou seja, não é um
    plano de assinatura recorrente automática no Stripe Billing por
    padrão; tratar como cobrança avulsa após confirmação humana).

### 2.6 Planner: de `localStorage` para banco real

- Tabela `planner_items` (ou equivalente) com `user_id` obrigatório,
  isolando os dados de cada cliente no servidor — não mais no navegador.
- Migração de UX: ao logar, o Planner passa a buscar/gravar via API
  autenticada em vez de ler/escrever `localStorage` diretamente.
- Isolamento reforçado no nível de query (toda leitura/escrita filtrada por
  `user_id` da sessão) e, se a opção de banco escolhida for Supabase,
  reforçado ainda por Row Level Security no próprio Postgres.

## 3. O que NÃO foi feito nesta tarefa (propositalmente)

Nenhum código de backend, autenticação, banco de dados, Resend ou Stripe foi
implementado. Esta tarefa é só backup + repositório git + esta documentação
de arquitetura + o plano de deploy/rollback (`DEPLOY_AND_ROLLBACK.md`). A
reconstrução real do frontend/backend só deve começar depois que os
arquivos de referência visual/funcional chegarem.
