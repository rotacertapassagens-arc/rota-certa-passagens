-- Financeiro: orçamentos de passagem (antes da venda).
-- Só acrescenta tabelas; nenhuma venda, recibo, parcela ou lote existente é alterado.

-- Número do orçamento (ORC-AAAA-NNN), um contador por ano.
CREATE TABLE fin_quote_counters (
  year INTEGER PRIMARY KEY,
  last_value INTEGER NOT NULL
);

-- Um orçamento independe de venda: nasce antes dela. Os dados do documento ficam em JSON para o PDF poder ser regenerado igual.
CREATE TABLE fin_quotes (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  issued_on TEXT NOT NULL,
  valid_until TEXT,
  customer_name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('EUR','BRL','USD','GBP')),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined')),
  data TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX fin_quotes_issued_idx ON fin_quotes (issued_on DESC);
