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

## Evidência a guardar em cada release

- commit e hash da imagem;
- saída dos testes e health check;
- versão da migração;
- identificador e verificação do backup;
- resultado do teste de restauração;
- responsável pela aprovação e horário da ativação.
