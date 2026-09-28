-- Mirrors migrations/0014_finance_performance_indexes.sql — SQLite supports partial indexes too.
CREATE INDEX fin_obligations_competency_idx ON fin_obligations (competency_date);
CREATE INDEX fin_obligation_payments_paid_at_idx ON fin_obligation_payments (paid_at);
CREATE INDEX fin_receivable_payments_received_at_idx ON fin_receivable_payments (received_at);
CREATE INDEX fin_mileage_lots_expires_idx ON fin_mileage_lots (expires_at) WHERE expires_at IS NOT NULL;
