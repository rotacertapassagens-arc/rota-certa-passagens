-- Saldo das contas na moeda da própria conta (ex.: cofrinho do Mercado Pago em R$).
-- Só acrescenta duas colunas; nenhum pagamento existente é alterado.
--
-- Quando uma conta em R$ recebe uma venda cobrada em € (ou paga uma conta em €), o pagamento continua em € (a moeda da
-- venda ou da conta a pagar) e este campo guarda quanto entrou ou saiu de verdade na moeda da conta, para o saldo bater
-- com o app do banco. Fica nulo quando a conta tem a mesma moeda do pagamento.
ALTER TABLE fin_receivable_payments ADD COLUMN account_amount_cents INTEGER;
ALTER TABLE fin_obligation_payments ADD COLUMN account_amount_cents INTEGER;
