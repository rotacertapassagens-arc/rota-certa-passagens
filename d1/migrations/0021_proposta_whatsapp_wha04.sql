-- WHA-04: o pedido de proposta do site passa o atendimento para o WhatsApp.
-- Só acrescenta colunas e tabelas; nenhum pedido existente é alterado. Pedidos antigos continuam com o
-- protocolo antigo (RC-AAAAMMDD-XXXXXX) e sem aceite do WhatsApp registrado.

-- Protocolo novo RC-AAAA-NNNNN: um contador por ano, incrementado na mesma transação que grava o pedido.
CREATE TABLE protocol_counters (
  year INTEGER PRIMARY KEY,
  last_value INTEGER NOT NULL
);

-- Idempotência: a página gera um identificador por envio; reenviar o mesmo envio devolve o mesmo protocolo.
ALTER TABLE lead_requests ADD COLUMN submission_id TEXT;
ALTER TABLE lead_requests ADD COLUMN submission_hash TEXT;
CREATE UNIQUE INDEX lead_requests_submission_idx ON lead_requests(submission_id) WHERE submission_id IS NOT NULL;

-- Telefone só com dígitos (com código do país), usado na conferência protocolo + telefone do WHA-04.
ALTER TABLE lead_requests ADD COLUMN customer_phone_digits TEXT;

-- Aceite explícito do contato pelo WhatsApp (texto versionado do formulário).
ALTER TABLE lead_requests ADD COLUMN whatsapp_consent_at TEXT;
ALTER TABLE lead_requests ADD COLUMN consent_version TEXT;

-- Preferência de escalas (opcional no formulário).
ALTER TABLE lead_requests ADD COLUMN stops_preference TEXT;

-- Origem da visita.
ALTER TABLE lead_requests ADD COLUMN utm_source TEXT;
ALTER TABLE lead_requests ADD COLUMN utm_medium TEXT;
ALTER TABLE lead_requests ADD COLUMN utm_campaign TEXT;
ALTER TABLE lead_requests ADD COLUMN utm_content TEXT;
ALTER TABLE lead_requests ADD COLUMN utm_term TEXT;
ALTER TABLE lead_requests ADD COLUMN source_page TEXT;
ALTER TABLE lead_requests ADD COLUMN source_referrer TEXT;
ALTER TABLE lead_requests ADD COLUMN source_captured_at TEXT;
