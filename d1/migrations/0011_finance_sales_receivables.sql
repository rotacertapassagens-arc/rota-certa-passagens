PRAGMA foreign_keys = ON;

-- Mirrors migrations/0011_finance_sales_receivables.sql in SQLite/D1 dialect.

CREATE TABLE fin_sales (
  id TEXT PRIMARY KEY,
  lead_request_id TEXT NOT NULL UNIQUE REFERENCES lead_requests(id) ON DELETE RESTRICT,
  protocol TEXT NOT NULL,
  sale_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross_amount_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  net_amount_cents INTEGER NOT NULL,
  passenger_count INTEGER,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  internal_notes TEXT,
  terminated_at TEXT,
  terminated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  termination_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('confirmed','canceled','refunded')),
  CHECK (gross_amount_cents > 0),
  CHECK (discount_cents >= 0),
  CHECK (net_amount_cents > 0),
  CHECK (net_amount_cents = gross_amount_cents - discount_cents),
  CHECK ((status IN ('canceled','refunded')) = (terminated_at IS NOT NULL))
);
CREATE INDEX fin_sales_status_idx ON fin_sales (status, sale_date);
CREATE INDEX fin_sales_partner_idx ON fin_sales (partner_id);

CREATE TABLE fin_receivables (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES fin_sales(id) ON DELETE RESTRICT,
  installment_number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  expected_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  account_id TEXT REFERENCES fin_accounts(id) ON DELETE SET NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  canceled_at TEXT,
  canceled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (sale_id, installment_number),
  CHECK (installment_number >= 1),
  CHECK (expected_amount_cents > 0),
  CHECK (method IN ('pix','transfer','card','cash','boleto','other')),
  CHECK (status IN ('open','partial','paid','canceled','refunded')),
  CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
);
CREATE INDEX fin_receivables_due_idx ON fin_receivables (status, due_date);
CREATE INDEX fin_receivables_sale_idx ON fin_receivables (sale_id);
CREATE INDEX fin_receivables_currency_idx ON fin_receivables (currency);

CREATE TABLE fin_receivable_payments (
  id TEXT PRIMARY KEY,
  receivable_id TEXT NOT NULL REFERENCES fin_receivables(id) ON DELETE RESTRICT,
  received_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  account_id TEXT NOT NULL REFERENCES fin_accounts(id) ON DELETE RESTRICT,
  gateway_fee_cents INTEGER,
  reference TEXT,
  reversal_of TEXT REFERENCES fin_receivable_payments(id) ON DELETE RESTRICT,
  reversal_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (received_amount_cents <> 0),
  CHECK (gateway_fee_cents IS NULL OR gateway_fee_cents >= 0),
  CHECK ((reversal_of IS NOT NULL) = (reversal_reason IS NOT NULL))
);
CREATE INDEX fin_receivable_payments_receivable_idx ON fin_receivable_payments (receivable_id, created_at DESC);
CREATE UNIQUE INDEX fin_receivable_payments_reversal_unique_idx ON fin_receivable_payments (reversal_of) WHERE reversal_of IS NOT NULL;
