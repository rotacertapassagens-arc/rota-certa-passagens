# Orçamentos de passagem

Data: 23/10/2026. Só o site rotacertapassagens.com (nada do FinanceHub).

## O que mudou para quem usa

`/financeiro` ganhou o botão **Orçamentos** na lateral (grupo Vendas). O orçamento vem **antes** da venda: monte, mande o PDF ao cliente e, quando ele fechar, lance a venda em "Vendas e recibos".

- **Lista** (`/financeiro#/orcamentos`): número, cliente, rota completa (ex.: LIS → MCZ → LIS), total, validade e situação (Rascunho, Enviado, Aceito, Recusado). Busca por cliente, número ou rota. "Vencido" aparece quando a validade passou e o orçamento ainda é rascunho ou enviado.
- **Novo orçamento** (`/orcamento.html`): formulário à esquerda e folha A4 igual ao modelo do recibo à direita.
  1. Cliente, contato (WhatsApp ou e-mail) e bagagem.
  2. Itinerário: um bloco por trecho (voo, companhia, siglas, cidades, horários, classe).
  3. **Preço por passageiro**: linhas com descrição, quantidade e valor unitário. Cada linha é do tipo **Passageiro** (entra na contagem "3 passageiros") ou **Extra** (taxa de serviço, bagagem, seguro: soma no total, mas não conta como passageiro).
  4. Valor equivalente em outra moeda (informativo, ex.: R$ ao lado do €). Nunca entra em soma.
  5. Formas de pagamento e condições (texto padrão se ficar vazio).
- **Salvar orçamento** numera sozinho a partir do 500 (`ORC-2026-500`, `501`...), para a agência não parecer nova. **Imprimir / Salvar PDF** gera o PDF para mandar no WhatsApp. A validade começa em 3 dias a partir da emissão e pode ser trocada.
- A folha cabe em **uma página A4**. Se o orçamento for grande (muitos trechos ou linhas), o texto fica compacto e, no limite, a folha encolhe só o necessário na impressão (mesma regra do recibo).

O orçamento **não cria venda, não mexe em caixa, lucro nem contas**. Apagar um orçamento não reaproveita o número.

## Rotas novas (`worker/finance-extras.ts`, só master)

| Rota | Função |
|---|---|
| `GET /api/admin/finance/quotes` | Lista (até 500), com rota resumida. |
| `POST /api/admin/finance/quotes` | Cria e devolve `{ id, number }`. |
| `GET /api/admin/finance/quotes/<id>` | Lê um orçamento com todos os dados. |
| `PUT /api/admin/finance/quotes/<id>` | Edita (o número não muda). |
| `DELETE /api/admin/finance/quotes/<id>` | Apaga. |

O total é sempre calculado no servidor (soma de quantidade x valor unitário). Moeda, datas, quantidades (1 a 99), até 12 trechos e até 10 linhas são validados; a validade não pode ser antes da emissão.

## Banco de dados: migration 0039 (só acrescenta)

`d1/migrations/0039_financeiro_orcamentos.sql`: duas tabelas novas, `fin_quote_counters` (contador por ano; o primeiro número de cada ano é 500, definido no Worker) e `fin_quotes` (dados do documento em JSON). Nenhuma tabela, linha ou coluna existente é alterada.

## Como publicar

A ordem importa: o merge na `main` publica o site sozinho, então o banco precisa estar pronto antes.

1. **Antes do merge**: `npm run d1:migrate:remote` (aplica só a 0039; o wrangler da máquina já tem login com escrita no D1).
2. Mesclar o PR na `main` (quem mescla é o Carlos). O site publica sozinho.
3. Conferir em `/financeiro#/orcamentos`: criar um orçamento de teste, gerar o PDF e apagar o teste.

## Voltar atrás

Como a migration só acrescenta, basta publicar a versão anterior do Worker. As tabelas novas ficam sem uso e não atrapalham nada.

## Testes

`tests/financeiro-painel.smoke.test.ts` (Worker real + D1 local): validações, numeração em sequência, total no servidor, edição, tipo da linha, rota completa, que o orçamento não aparece nas vendas e apagar. Esta máquina leva ~60 s só para aplicar as migrations; use `--hookTimeout=300000` ao rodar.

## Limites conhecidos

- O PDF é gerado pelo navegador (Imprimir / Salvar como PDF), como no recibo. O arquivo não fica guardado no site; o orçamento fica salvo e dá para reabrir e gerar de novo.
- Não há botão "Aceitar e virar venda" nem link para o cliente abrir no celular (não foram pedidos). Os dois cabem como próximo passo.
- Um orçamento com mais de 7 trechos fica no modo denso e, se ainda passar de uma folha, encolhe até 60%.
