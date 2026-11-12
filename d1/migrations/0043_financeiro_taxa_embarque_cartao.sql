-- Financeiro: a taxa de embarque da emissão passa a guardar em qual cartão (conta) foi paga.
-- fees_account_id: a conta/cartão escolhido. fees_obligation_id: a conta a pagar de custo direto criada já paga nessa conta,
-- para o saldo e a fatura do cartão refletirem o gasto. O lucro NÃO soma essa conta a pagar: ele continua vindo do custo da emissão.
-- Só acrescenta colunas nulas; nada existente muda.

ALTER TABLE fin_issuances ADD COLUMN fees_account_id TEXT REFERENCES fin_accounts(id) ON DELETE SET NULL;
ALTER TABLE fin_issuances ADD COLUMN fees_obligation_id TEXT REFERENCES fin_obligations(id) ON DELETE SET NULL;
