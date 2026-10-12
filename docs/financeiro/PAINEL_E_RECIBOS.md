# Painel financeiro novo, vendas diretas e recibos

Data: 12/10/2026. Só o site rotacertapassagens.com (nada do FinanceHub).

## O que mudou para quem usa

`/financeiro` agora tem uma coluna lateral com um botão para cada área:

| Botão | O que mostra |
|---|---|
| Visão geral | Faturamento recebido, vendido, a receber, custo dos voos, lucro confirmado, margem, despesas, resultado e saldo de caixa, **uma linha de cartões por moeda** (€ e R$ nunca são somados). Gráfico mês a mês, 5 voos mais lucrativos e "atenção agora". |
| Vendas e recibos | Todas as vendas, com situação (recebida, a receber), valor em € com o equivalente em R$ embaixo, e botão do recibo. **Nova venda** funciona com ou sem proposta. |
| Lucro por voo | Cada voo com recebido, custo, lucro e margem. "Custo e lucro" abre a janela de emissões: lote de milhas, taxas, PNR e "marcar como emitida". |
| Contas e saldos | O saldo de cada conta **na moeda dela** (ex.: o cofrinho do Mercado Pago em R$), para conferir com o app do banco, e a conversão automática para euros pelo câmbio do dia (Banco Central Europeu, mesma fonte do Planner). Mostra saldo inicial, entradas e saídas. |
| Contas a receber | Parcelas ainda não recebidas, com vencimento e botão de recebimento. Começa vazia, porque hoje tudo é recebido na hora. |
| Contas a pagar, Alertas, Milhas, Assinaturas, Cadastros | As telas que já existiam, agora separadas, com valores em reais/euros (não mais em centavos) e janelinhas no lugar das caixas do navegador. |

### Regras de dinheiro

- Faturamento "recebido" vem do caixa (pagamentos registrados). "Vendido" é a competência. Os dois aparecem lado a lado.
- **Lucro confirmado só existe depois que uma emissão é marcada como emitida.** Venda sem custo emitido aparece como "Sem custo" ou "Custo pendente" e não entra no lucro, para o lucro nunca parecer maior que o real.
- O custo das milhas vem do custo médio do lote usado (regra que já existia em `shared/mileageCost.ts`).
- O valor em outra moeda (ex.: R$ 6.726,00 de uma venda em € 1.200,00) é **só informativo**: aparece no recibo e nas vendas, e nunca entra em soma.

## Recibo

`/recibo.html?sale=<id da venda>`: formulário à esquerda e prévia A4 igual ao modelo à direita.

1. O recibo nasce preenchido pela venda (cliente, rota, valor, PNR e bilhete das emissões).
2. Preencha itinerário e linhas de valor (passagem, taxa de serviço etc.). O total é a soma das linhas; se diferir do valor da venda, aparece um aviso.
3. **Salvar recibo**, depois **Imprimir / Salvar PDF** (escolher "Salvar como PDF").
4. Anexe o PDF gerado no próprio recibo (até 1,4 MB, 5 arquivos por recibo). Fica guardado junto da venda.
5. O valor por extenso sai em português de Portugal para €/£ ("dezassete cêntimos") e do Brasil para R$/US$.

## Rotas novas (`worker/finance-extras.ts`, só master)

| Rota | Função |
|---|---|
| `POST /api/admin/finance/sales/direct` | Cria a venda sem proposta. Se "já recebido", cria também a parcela e o recebimento, tudo numa só gravação. Protocolo `VD-AAAA-NNNNN`. |
| `PATCH /api/admin/finance/sales/<id>` | Define ou remove o valor equivalente em outra moeda. |
| `GET /api/admin/finance/flights` | Lista de voos com emissões e lucro. |
| `GET /api/admin/finance/receivables` | Contas a receber (`?status=all` inclui as pagas). |
| `GET` e `PUT /api/admin/finance/sales/<id>/receipt` | Lê e grava o recibo da venda (um por venda). |
| `POST /api/admin/finance/receipts/<id>/files` | Anexa PDF ou imagem. |
| `GET` e `DELETE /api/admin/finance/receipt-files/<id>` | Abre ou remove um anexo. |

A venda direta cria uma linha em `lead_requests` com `kind='direct_sale'` só para manter a ligação que `fin_sales` exige. Ela **não aparece na Central de Propostas** e não cria comissão de parceiro.

### Conta em outra moeda (cofrinho em R$)

Uma venda cobrada em € e paga em R$ por PIX no cofrinho continua em € no financeiro, mas o saldo da conta precisa subir em R$. Por isso, quando a moeda da conta é diferente da moeda do pagamento, o site **exige o valor que entrou (ou saiu) na moeda da conta**:

- Nova venda: o "equivalente em R$" é o valor creditado no cofrinho.
- Registrar recebimento e pagar conta: campo "Valor que entrou/saiu da conta".
- Estornos devolvem exatamente o mesmo valor em R$.
- Se faltar esse valor (pagamentos antigos), o saldo mostra "inclui valores estimados pelo câmbio".
- O saldo inicial da conta é digitado em Cadastros (o que o app do banco mostra no dia).

Rota: `GET /api/admin/finance/accounts/balances`.

## Banco de dados: migrations 0022 e 0023 (só acrescentam)

`d1/migrations/0022_financeiro_recibos.sql`: duas colunas novas em `fin_sales` (`alt_currency`, `alt_amount_cents`) e três tabelas novas (`fin_direct_sale_counters`, `fin_receipts`, `fin_receipt_files`).

`d1/migrations/0023_saldo_na_moeda_da_conta.sql`: uma coluna nova (`account_amount_cents`) em `fin_receivable_payments` e em `fin_obligation_payments`.

Nenhuma tabela, linha ou coluna existente é alterada ou apagada.

## Como publicar

A ordem importa: o merge na `main` publica o site sozinho, então o banco precisa estar pronto antes.

1. **Antes do merge**, no PowerShell, com o token do Cloudflare: `npm run d1:migrate:remote`. Aplica a 0022 e a 0023. Como ela só acrescenta, a versão antiga do site continua funcionando normalmente depois dela.
2. Mesclar o PR na `main` (quem mescla é você, no GitHub). O site publica sozinho.
3. Revogar o token do Cloudflare.
4. Conferir em `/financeiro` (a lateral aparece) e lançar uma venda de teste.

## Voltar atrás

Como a migration só acrescenta, basta fazer o deploy da versão anterior do Worker. As tabelas e colunas novas ficam sem uso e não atrapalham nada.

## Limites conhecidos

- Só o Worker (Cloudflare + D1) foi atualizado. O runtime Node/Postgres de `src/` não tem estas rotas; ele não é o que está publicado.
- O recibo guarda o PDF em base64 no D1 (mesma escolha dos anexos do Planner). Se o volume crescer, o caminho é o R2.
- As vendas já emitidas antes (Maksiel e Giovane) precisam ser lançadas depois do deploy; os dois PDFs antigos podem ser anexados aos recibos novos.
