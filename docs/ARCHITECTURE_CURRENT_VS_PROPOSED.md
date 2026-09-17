# Arquitetura — site público Rota Certa Passagens

Escopo exclusivo: `rotacertapassagens.com`. O Rota Certa OS e toda a infraestrutura operacional permanecem fora deste projeto.

## Origem preservada

O HTML publicado e a versão mais recente recebida têm o mesmo SHA-256: `1579086D9FBA2C09AFC55E4EE4FD6EEF1ACE64E861027D20E7B40583D9E2A5E5`. O arquivo recebido também permanece intacto no diretório `reference/`.

## Antes

```text
Navegador -> HTML/CSS/JS estático -> localStorage
                                 -> funções Cloudflare anexadas
```

O Planner e a identidade do cliente dependiam do navegador. A senha aparecia em texto legível no `localStorage`; a sessão e o isolamento não eram validados por um servidor. As funções anexadas usavam KV/Notion e um fluxo de acesso orientado pelo cliente.

## Implementação local atual

```text
Navegador
  -> Fastify / cookies HttpOnly / CSRF / rate limit
      -> PostgreSQL
          -> usuários, sessões, tokens, papéis
          -> assinaturas e pagamentos
          -> viagens e dados do Planner com owner_user_id
      -> e-mail capturado localmente ou Resend futuramente
      -> Stripe somente sandbox, ativação apenas por webhook assinado
```

O frontend continua em HTML/CSS/JavaScript para preservar a identidade visual. A lógica sensível saiu do navegador. A importação de dados antigos do Planner é explícita e cria uma viagem separada; não sobrescreve dados persistidos.

## Estado por camada

| Camada | Implementada localmente | Testada | Publicada |
|---|---:|---:|---:|
| Visual público e navegação | Sim | Sim, estrutural | Não |
| Cadastro, confirmação e login | Sim | Sim | Não |
| Sessões, CSRF e revogação | Sim | Sim | Não |
| Planner persistente e isolamento | Sim | Sim | Não |
| Recuperação de senha | Sim | Sim | Não |
| Master por convite | Sim | Sim | Não |
| Stripe sandbox | Sim | Bloqueio sem credenciais testado; API externa não chamada | Não |
| E-mail real | Adaptador preparado | Captura local testada | Não configurado |
| DNS/Cloudflare | Não alterado | Não aplicável | Estado existente preservado |

## Deliberações

- O teste Free dura 10 dias e permite uma viagem ativa e duas arquivadas. Depois do prazo, os dados permanecem guardados e o Planner solicita o Premium, que libera viagens ativas e histórico ilimitados; checkout e preço continuam desativados até aprovação comercial.
- O serviço personalizado continua com confirmação humana, sem checkout automático.
- Depoimentos e métricas públicas não comprovados foram ocultados na nova versão, mas preservados na referência original.
- O painel master mostra contas, planos e pagamentos; não recebe acesso ao conteúdo privado dos Planners.
