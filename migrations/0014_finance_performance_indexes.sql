-- Módulo financeiro (Fase 7 — revisão de performance): índices que faltavam para as consultas
-- por período introduzidas pelo dashboard (Fase 6) e por relatórios em regime de caixa —
-- competency_date/paid_at/received_at eram filtrados sem índice, forçando varredura completa das
-- tabelas fin_obligations/fin_obligation_payments/fin_receivable_payments à medida que crescem.
CREATE INDEX fin_obligations_competency_idx ON fin_obligations (competency_date);
CREATE INDEX fin_obligation_payments_paid_at_idx ON fin_obligation_payments (paid_at);
CREATE INDEX fin_receivable_payments_received_at_idx ON fin_receivable_payments (received_at);
CREATE INDEX fin_mileage_lots_expires_idx ON fin_mileage_lots (expires_at) WHERE expires_at IS NOT NULL;
