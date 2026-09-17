# Prompt para colar na IA do Notion

Cole isto na caixa de pesquisa/IA do Notion (dentro do workspace onde
quer receber os dados do site):

---

Cria uma nova base de dados (tabela) chamada "Rota Certa — Leads do
Site", com estas colunas, exatamente com este nome e este tipo:

- Nome — tipo Título
- Email — tipo Email
- Origem — tipo Texto
- Destino — tipo Texto
- Data de ida — tipo Data
- Data de volta — tipo Data
- Passageiros — tipo Texto
- Tipo de viagem — tipo Selecionar
- Observações — tipo Texto
- Plano — tipo Selecionar
- Tipo — tipo Selecionar
- Já tinha conta — tipo Caixa de verificação
- Data — tipo Data

Não apagues nenhuma coluna que já exista lá por padrão (como
"Nome"/título) — só garante que as colunas acima existem com estes
nomes exatos.

---

## O que fica por sua conta (a IA não pode fazer isto por si)

Depois de a base de dados estar criada, faltam só dois passos manuais
— nenhuma IA pode fazer isto por questões de segurança da sua conta:

### 1. Criar o token secreto
1. Vá a [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Clique em "+ New integration"
3. Dê um nome (ex.: "Rota Certa — Site") e guarde
4. Copie o "Internal Integration Secret" (começa por `secret_` ou `ntn_`)

### 2. Ligar a integração à base de dados
1. Abra a base de dados "Rota Certa — Leads do Site" que a IA criou
2. Clique nos "..." no canto superior direito
3. Vá a "Conexões" (ou "Connections") → adicione a integração criada no passo 1
4. Copie o ID da base de dados: é a sequência de 32 caracteres que
   aparece no link da página, logo depois do nome do workspace

Depois é só colar esses dois valores (token + ID da base de dados) nas
variáveis de ambiente do Cloudflare Pages, como já está explicado em
`LEIA-ME-CONFIGURACAO.md`.
