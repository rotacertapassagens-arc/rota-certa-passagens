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
