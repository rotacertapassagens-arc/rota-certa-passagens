# Preparação de deploy e rollback

Este é um procedimento preparado, não executado. Nenhum deploy, push, DNS, Cloudflare, e-mail real ou cobrança real foi alterado nesta entrega.

## Portões obrigatórios antes de publicar

1. Aprovar visual e textos, incluindo preço do Premium e provas sociais.
2. Definir hospedagem separada do Rota Certa OS e banco Postgres gerenciado.
3. Criar segredos exclusivos; nunca reutilizar credenciais operacionais.
4. Configurar remetente e DNS de e-mail somente após autorização e validar SPF, DKIM e DMARC.
5. Configurar Stripe em modo teste, validar um checkout e webhook de ponta a ponta, e manter produção bloqueada.
6. Executar `pnpm typecheck`, `pnpm test`, `pnpm build` e teste visual em preview privado.
7. Fazer backup do banco, registrar o commit exato e revisar migrações para frente e para trás.

## Sequência futura de implantação

1. Criar ambiente de preview privado sem dados reais.
2. Aplicar `pnpm db:migrate` no banco vazio.
3. Publicar a imagem construída pelo `Dockerfile` com `COOKIE_SECURE=true`.
4. Executar `/api/health`, cadastro de teste, confirmação capturada, login e Planner de teste.
5. Testar Stripe apenas com chave `sk_test_` e webhook assinado.
6. Só depois de aprovação explícita, planejar a troca do tráfego público.

## Rollback

- Aplicação: reimplantar a imagem/commit anterior, sem editar arquivos diretamente no servidor.
- Banco: interromper escritas, guardar um novo dump de evidência e executar a migração `.down.sql` apenas se ela for compatível com os dados criados. Caso contrário, restaurar o snapshot anterior em banco separado e validar antes de apontar a aplicação.
- Frontend: reativar o artefato anterior; o snapshot histórico continua em `backup-publicado-2026-09-16/`.
- Pagamentos: desativar checkout, preservar webhooks/eventos idempotentes e reconciliar qualquer evento de sandbox pendente.
- DNS: não alterar durante um rollback de aplicação salvo se houver plano explícito e TTL conhecido.

## Migração 0005 — programa de parceiros

- `migrations/0005_partner_referrals.sql` / `.down.sql` (PostgreSQL) e `d1/migrations/0005_partner_referrals.sql` (D1) criam `partners`, `referral_clicks`, `partner_commissions`, `notification_outbox`, estendem `lead_requests` com colunas de atribuição/venda, e ampliam os `CHECK` de `user_roles.role` e `account_tokens.purpose` para incluir `partner`/`partner_invite`.
- O rollback (`0005_partner_referrals.down.sql`) foi validado localmente (script ad-hoc contra a mesma engine SQL usada pelos testes automatizados): aplica, reverte e confirma que as tabelas e colunas novas desaparecem sem quebrar `lead_requests`. Ele usa `DROP TABLE ... CASCADE` para as tabelas `partners`/`referral_clicks`, então **execute-o apenas em uma janela controlada**, pois remove permanentemente todo o histórico de parceiros, cliques e comissões — não há como recuperar esses dados depois.
- Rollback com dados reais: se já existirem linhas com `role='partner'`, `purpose='partner_invite'` ou `lead_requests.partner_id` preenchido, decida antes se elas devem ser limpas manualmente ou se o rollback deve ser adiado — o down-migration não apaga usuários/leads, só as tabelas e colunas específicas do programa de parceiros.
- D1 (`wrangler d1 migrations apply DB --local`) foi aplicada e verificada localmente; D1/wrangler não tem mecanismo nativo de rollback automático (o projeto já não tinha `.down.sql` para D1 antes desta tarefa) — um rollback em D1 remoto exigiria uma migração reversa escrita à mão e aplicada com `--remote`, o que é um passo do portão de produção, não desta entrega.
- `wrangler.jsonc`: `assets.run_worker_first` agora inclui `"/i/*"` além de `"/api/*"`, para que o Worker processe o redirecionamento do link de indicação antes de cair no fallback estático. Confirme esse campo ao publicar o Worker.

## Evidência a guardar em cada release

- commit e hash da imagem;
- saída dos testes e health check;
- versão da migração;
- identificador e verificação do backup;
- resultado do teste de restauração;
- responsável pela aprovação e horário da ativação.
