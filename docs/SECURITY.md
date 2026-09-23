# Segurança e privacidade

## Controles implementados

- Senhas derivadas com `scrypt`, salt individual e comparação resistente a timing.
- Códigos de confirmação e tokens de recuperação/convite salvos apenas como SHA-256 com pepper.
- Código de e-mail com expiração, limite de tentativas e invalidação após uso.
- Recuperação de senha com resposta indistinguível para e-mail existente ou inexistente.
- Sessão opaca em cookie `HttpOnly`, `SameSite=Lax`, revogável e com expiração.
- Cookie CSRF separado, cabeçalho obrigatório e validação de `Origin` em mutações autenticadas.
- Rate limit persistido para cadastro, login, confirmação, recuperação e leads.
- Cabeçalhos CSP, HSTS em produção, `nosniff`, bloqueio de iframe e política restritiva de permissões.
- Redação de senha, cookies, autorização e tokens nos logs.
- Todas as tabelas de conteúdo privado possuem `owner_user_id`; leituras e mutações do Planner filtram pela identidade da sessão.
- O master não possui endpoint para ler conteúdo privado de viagens.
- Webhook Stripe exige assinatura e tolerância temporal, registra eventos idempotentes e só ativa acesso após pagamento confirmado.
- Produção Stripe não é aceita pela configuração atual; somente chaves `sk_test_`.

## Dados pessoais

O banco contém e-mail, nome, dados de viagens e metadados mínimos de segurança. IP é guardado apenas como hash com segredo. Evite incluir dados de documento, cartão ou saúde nas notas. O pagamento usa checkout hospedado e o sistema não armazena dados de cartão.

## Programa de parceiros (indicação)

- **Atribuição não é confiável do cliente.** O parâmetro `?ref=` na URL só serve para exibir o banner; a atribuição real usada na criação da proposta é sempre resolvida no servidor a partir do cookie `rc_ref` (`HttpOnly`, `SameSite=Lax`, assinado com HMAC-SHA256 sob `TOKEN_PEPPER`) ou, na ausência dele, de um código digitado manualmente e revalidado contra a tabela `partners` (deve existir e estar `active=true`). Um código inexistente ou inativo nunca gera atribuição. O cliente não pode enviar um `partnerId` interno diretamente — a API só aceita um código de texto, sempre re-resolvido no servidor.
- **Cookie assinado, não apenas guardado.** `rc_ref` carrega `código.timestamp.assinatura`; a assinatura impede que o cliente forje ou estenda artificialmente a janela de atribuição alterando o valor do cookie. Um cookie com assinatura inválida é tratado como "nenhuma atribuição", nunca como erro fatal.
- **Cliques não guardam IP puro.** `referral_clicks.ip_hash` e `visitor_hash` são HMAC-SHA256 com `RATE_LIMIT_SECRET`/`TOKEN_PEPPER`, iguais ao padrão já usado em `lead_requests.ip_hash` e `sessions.ip_hash`. Retenção segue a mesma política do restante do banco (sem expurgo automático nesta entrega; pendência de política formal de retenção continua listada abaixo).
- **Falha de telemetria nunca bloqueia o redirecionamento.** O registro do clique em `/i/{code}` roda em `try/catch` isolado; se a escrita falhar, o parceiro ainda é redirecionado normalmente.
- **Sem PII no painel do parceiro.** `GET /api/partner/summary` e `GET /api/partner/ledger` nunca selecionam `customer_name`, `customer_email`, `customer_phone` ou `notes`. O protocolo é mascarado (`RC-20260910-A1••••`) antes de sair da API. Toda consulta do parceiro filtra por `partners.user_id = <sessão autenticada>`, nunca por um id vindo da requisição — testado explicitamente em `tests/partners.test.ts` (dois parceiros isolados, inclusive tentando `?partnerId=` de outro parceiro).
- **Dinheiro é sempre inteiro.** Comissão fixa em centavos (`commission_fixed_cents`), comissão percentual em pontos-base (`commission_percentage_bps`, 1% = 100 bps); nenhum cálculo financeiro usa ponto flutuante. O valor da comissão fica congelado (`commission_type_snapshot`, `commission_rate_snapshot`) no momento da conversão — alterar a regra do parceiro depois nunca altera retroativamente uma comissão já criada.
- **Comissão nunca duplica.** `partner_commissions.lead_request_id` é único; a criação é feita dentro de uma transação com verificação prévia (`SELECT` existente) e fallback a uma segunda leitura em caso de corrida, então repetir a chamada de conversão é sempre idempotente.
- **Anular exige motivo auditado.** Mover uma proposta para fora de `converted` enquanto existir uma comissão `pending`/`approved` é bloqueado (`409 commission_void_reason_required`) até que um motivo textual seja enviado; a anulação fica registrada em `partner_commissions.void_reason` e em `audit_events`.
- **Convite de parceiro segue o padrão já auditado do convite master:** código de 6 dígitos, hash com pepper, expiração de 15 minutos, limite de 5 tentativas falhas e uso único (`account_tokens.purpose='partner_invite'`). O vínculo `partners.user_id` é único e imutável por criação de convite (um usuário só pode estar ligado a um parceiro). Desativar o parceiro (`active=false`) não apaga a conta nem o histórico; para revogar o acesso à sessão em si, um master suspende o usuário como qualquer outra conta (`users.status`), preservando `partner_commissions` e `lead_requests` já registrados.
- **Notificações são só deste repositório.** `notification_outbox` guarda cada evento (`referral_confirmed`, `proposal_converted`, `commission_paid`, `weekly_summary`) com `idempotency_key` único; reprocessar nunca duplica. Em `EMAIL_MODE=capture` (padrão local) nada é enviado de verdade. O adaptador de WhatsApp é um webhook autenticado (`WHATSAPP_WEBHOOK_URL`/`WHATSAPP_WEBHOOK_TOKEN`), desligado por padrão (`WHATSAPP_NOTIFICATIONS_ENABLED=false`) e nunca acoplado diretamente à VPS/n8n — nenhum segredo de WhatsApp foi criado ou ativado nesta tarefa.
- **Endpoints de processamento (`/api/admin/notifications/process` e `.../weekly-summary`) aceitam duas formas de autenticação:** sessão master com CSRF (uso pelo painel) ou o segredo `NOTIFICATIONS_CRON_TOKEN` via `Authorization: Bearer` (uso por um agendador sem cookie de sessão, ex. Cloudflare Scheduled Event), seguindo o mesmo padrão de bootstrap por token já usado no primeiro convite master. Sem sessão válida e sem token correto, a rota responde `401`; com sessão válida mas sem papel master, `403`. Nenhum cron real foi configurado ou ativado nesta tarefa — `NOTIFICATIONS_CRON_TOKEN` fica vazio no `.env.example`.

## Pendências antes de produção

- revisão independente de segurança e dependências;
- política de retenção, exportação e eliminação de dados;
- backup criptografado e restauração comprovada;
- monitorização e resposta a incidentes;
- domínio de e-mail autenticado e processo de supressão;
- teste real em preview do provedor sandbox e do webhook;
- rotação, armazenamento e acesso aos segredos;
- definição jurídica de termos e privacidade.

## Comunicação de vulnerabilidade

Não incluir segredos ou dados reais em issues ou mensagens. Registre apenas passos mínimos, impacto, versão/commit e evidência anonimizada.
