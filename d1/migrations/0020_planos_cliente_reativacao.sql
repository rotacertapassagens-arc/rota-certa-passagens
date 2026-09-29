-- Modelo de planos definido pela Tais (2026-09-29):
-- - Free: 10 dias para testar (trial-10d, já existia).
-- - Premium: 9,99 € por 30 dias (planner-30d). Enquanto a Stripe não entra, a equipe libera pelo painel
--   depois do pagamento combinado no WhatsApp (Pix ou cartão).
-- - Cliente que compra passagem com a Rota Certa: Planner liberado até 7 dias depois da volta, para ele
--   planejar sozinho (cliente-rota-certa). Fica inativo na tabela pública de planos: não é vendido.
INSERT INTO plans (id, code, name, price_cents, currency, duration_days, checkout_enabled, active)
VALUES ('00000000-0000-4000-8000-000000000005', 'cliente-rota-certa', 'Planner Cliente Rota Certa', 0, 'EUR', NULL, 0, 0);

-- E-mail de reativação 7 dias antes da viagem, para quem está com o teste vencido (uma vez por viagem).
ALTER TABLE trips ADD COLUMN reactivation_sent_at TEXT;
