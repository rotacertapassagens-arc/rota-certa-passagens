# Deploy e rollback (proposta — nada disto está implementado ainda)

> Escopo: apenas o site público `rotacertapassagens.com`. Não confundir com
> o "Rota Certa OS" (painel interno, VPS `144.91.93.68`), que tem seu
> próprio processo de deploy, fora do escopo deste documento.

Nenhum passo abaixo foi executado. Nada foi implantado em produção. É um
plano para quando os arquivos de referência da namorada chegarem e o
backend real começar a ser construído.

## 1. Origem do código

- O repositório git criado em `C:\Users\usuario05\Documents\Carlos\Claude\rota-certa-site\`
  (commit inicial `fb9e560`, snapshot do site publicado) passa a ser a
  origem do código a partir de agora — histórico local por enquanto, sem
  remoto configurado.
- Quando o visual/funcionalidade real (arquivos da namorada) chegarem, eles
  entram como commits subsequentes neste mesmo repositório, preservando o
  snapshot do site publicado como ponto de referência histórico (nunca
  reescrever o commit inicial).
- Só depois de haver conteúdo estável faz sentido criar um remoto (GitHub
  ou similar) — decisão para depois, não incluída nesta tarefa.

## 2. Build (proposta)

- Se o frontend final continuar sendo HTML/CSS/JS estático (sem framework),
  o "build" pode ser trivial (nenhum bundler necessário, ou no máximo
  minificação). Se o dono do projeto optar por Next.js (o que facilitaria
  reaproveitar auth do Supabase e API routes no mesmo projeto), o build
  passa a ser `next build`, gerando um output estático ou híbrido
  (dependendo de quais páginas exigem servidor).
- Backend (auth, Planner, webhooks de pagamento, disparo de e-mail) proposto
  como um serviço separado do frontend estático — ver seção 3.

## 3. Onde seria o deploy (proposta, sem compromisso definitivo)

- **Frontend:** como o domínio já está no Cloudflare, **Cloudflare Pages**
  é a opção mais natural — deploy direto a partir do repositório git,
  preview automático por branch/PR, certificado e CDN já resolvidos pela
  mesma conta que já gerencia o DNS.
- **Backend (auth, Planner em banco real, webhooks Stripe, disparo Resend):**
  proposta de rodar separado do frontend estático, em algo simples e barato,
  por exemplo:
  - Um servidor Node/Express pequeno, ou
  - Next.js API routes (se o frontend for migrado para Next.js, unifica
    tudo em um único projeto/deploy).
  - Hospedagem barata compatível: Railway, Render, Fly.io ou uma Cloudflare
    Worker/Pages Function se a lógica couber no modelo de edge functions da
    Cloudflare (mais barato ainda, mas com mais restrições de runtime).
  - Nenhuma dessas opções foi contratada ou configurada — é só o leque de
    candidatos razoável dado o que já existe (Cloudflare no DNS).
- Configuração de `www` e dos registros de e-mail (MX/SPF/DKIM/DMARC,
  necessários para o Resend funcionar de forma confiável) precisa acontecer
  no mesmo momento em que o backend real for implantado — hoje nenhum dos
  dois existe.

## 4. Rollback (proposta)

- Nunca fazer deploy sobrescrevendo o build anterior sem versionamento.
- Cloudflare Pages já versiona cada deploy automaticamente por commit —
  usar isso a favor: manter a prática de dar tag/release no git a cada
  deploy de produção (ex. `v0.1.0`), para conseguir apontar exatamente qual
  commit está no ar a qualquer momento.
- Rollback = reativar o deploy anterior já versionado no Cloudflare Pages
  (ou, no backend separado, reimplantar a tag/release anterior) — nunca
  "consertar em produção" direto sem passar pelo git.
- Antes de qualquer deploy que mexa em auth/banco/pagamento, manter backup
  do banco de dados (dump do Postgres, ou snapshot do SQLite via
  Litestream) tirado imediatamente antes — migração de schema é o cenário
  de maior risco de precisar reverter.

## 5. Nada disto está pronto hoje

Confirmando o estado atual (evidência desta auditoria, 2026-09-16): o site é
servido estaticamente do Cloudflare sem pipeline de deploy versionado
conhecido por nós (não sabemos como o HTML atual chega lá hoje — não foi
investigado nesta tarefa, é matéria para quando o backend for de fato
implementado), não há backend, não há banco, não há Resend, não há Stripe.
Este documento é só o plano de destino, não uma descrição do que existe.
