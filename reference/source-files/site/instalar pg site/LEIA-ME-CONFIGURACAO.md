# Rota Certa Passagens — guia de configuração

## O que já está pronto no código

- Logótipo, fotos da equipa e restantes ficheiros em `/assets`
- Secção "Sobre nós" com Carlos Matos e Taís Vieira
- Link para a Política de Privacidade (LGPD) no rodapé
- Frase final atualizada: "Você escolhe o destino. Nós tratamos da rota."
- Formulário "Pedir proposta de voo" e o registo no Planejador já enviam
  os dados para `/functions/api/lead.js`
- O Planejador (`/planner`) só abre depois de o cliente criar conta com
  email — os 3 planos (grátis, 9,99 € e 49,99 €) passam todos primeiro
  pela Área do Cliente
- O plano grátis só permite **um registo por email**, controlado no
  servidor (não dá para contornar só limpando o navegador)

Isto só fica realmente ativo depois de ligar o Notion e o Cloudflare —
sem isso, o site funciona à mesma (o cliente consegue navegar e usar o
Planejador), mas os dados não chegam ao Notion e o "um registo por
email" não é aplicado a nível global.

## Passo 1 — Publicar no Cloudflare Pages

Envie a pasta toda (não só o `index.html`) para o Cloudflare Pages:

```
index.html
assets/
functions/
```

A pasta `functions/` é o que liga o site ao Notion — o Cloudflare
Pages deteta-a automaticamente e cria o endpoint `/api/lead`.

## Passo 2 — Criar a integração no Notion

1. Aceda a [notion.so/my-integrations](https://www.notion.so/my-integrations)
   e crie uma nova integração interna (ex.: "Rota Certa — Site").
2. Copie o **token secreto** gerado (começa por `secret_` ou `ntn_`).
3. Crie uma base de dados no Notion (uma tabela normal) para receber os
   pedidos, com estas colunas (o nome tem de ser exatamente este):

   | Nome da coluna     | Tipo         |
   |---------------------|--------------|
   | Nome                | Título       |
   | Email               | Email        |
   | Origem              | Texto        |
   | Destino             | Texto        |
   | Data de ida         | Data         |
   | Data de volta       | Data         |
   | Passageiros         | Texto        |
   | Tipo de viagem      | Selecionar   |
   | Observações         | Texto        |
   | Plano               | Selecionar   |
   | Tipo                | Selecionar   |
   | Já tinha conta      | Caixa de verificação |
   | Data                | Data         |

4. No canto superior direito da base de dados, clique em **"..."** →
   **Conexões** → adicione a integração que criou no passo 1.
5. Copie o **ID da base de dados**: é a sequência de 32 caracteres no
   link da base de dados, depois do nome do workspace e antes de `?v=`.

## Passo 3 — Ligar o Cloudflare Pages ao Notion

No painel do seu projeto no Cloudflare Pages:

1. **Settings → Environment variables**, adicione:
   - `NOTION_TOKEN` → o token do passo 2
   - `NOTION_DATABASE_ID` → o ID da base de dados do passo 2
2. **Settings → Functions → KV namespace bindings**:
   - Crie um namespace KV novo (ex.: `rota-certa-emails`)
   - Associe-o com o nome de variável `EMAIL_REGISTRY`

Depois de guardar, faça um novo deployment (ou "Retry deployment")
para as variáveis ficarem ativas.

## O que ainda fica por fazer (fora do que foi pedido)

- **Pagamento real dos planos 9,99 € e 49,99 €**: hoje, depois do
  registo, o cliente só fica com acesso liberado — ainda não há
  cobrança automática. Para isso é preciso ligar um meio de pagamento
  (Stripe, Multibanco/MB WAY via Vinti4, etc.), que é um passo à parte.
- **Login "real"**: a conta do cliente ainda vive no navegador dele
  (localStorage), não numa base de dados central — por isso, se o
  cliente mudar de computador ou limpar os dados do navegador, tem de
  criar conta outra vez (o registo em si, esse sim, fica guardado no
  Notion e não pode ser reaproveitado no plano grátis).
