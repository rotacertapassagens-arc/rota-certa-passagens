-- Financeiro: venda direta, valor equivalente em outra moeda e recibos.
-- Só acrescenta colunas e tabelas; nenhuma venda, parcela, emissão ou lote existente é alterado.

-- Valor equivalente informativo (ex.: venda em EUR paga em R$ por PIX). Nunca entra em somas entre moedas.
ALTER TABLE fin_sales ADD COLUMN alt_currency TEXT;
ALTER TABLE fin_sales ADD COLUMN alt_amount_cents INTEGER;

-- Protocolo das vendas lançadas direto no financeiro (VD-AAAA-NNNNN), separado do contador das propostas do site.
CREATE TABLE fin_direct_sale_counters (
  year INTEGER PRIMARY KEY,
  last_value INTEGER NOT NULL
);

-- Um recibo por venda. Os dados ficam em JSON para o recibo poder ser regenerado igual ao modelo.
CREATE TABLE fin_receipts (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL UNIQUE REFERENCES fin_sales(id) ON DELETE RESTRICT,
  number TEXT NOT NULL UNIQUE,
  issued_on TEXT NOT NULL,
  data TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- PDF (ou imagem) do recibo já emitido, anexado ao recibo. Guardado em base64 no D1, como os anexos do Planner.
CREATE TABLE fin_receipt_files (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES fin_receipts(id) ON DELETE RESTRICT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_b64 TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (size_bytes > 0)
);
CREATE INDEX fin_receipt_files_receipt_idx ON fin_receipt_files (receipt_id);
