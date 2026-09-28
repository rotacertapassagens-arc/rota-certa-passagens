PRAGMA foreign_keys = ON;

-- Mirrors migrations/0010_finance_subscriptions_obligations.sql in SQLite/D1 dialect: booleans as
-- INTEGER 0/1, dates as TEXT, no `~` regex (see 0009's note on the same portability constraint).

CREATE TABLE fin_subscriptions (
  id TEXT PRIMARY KEY,
  counterparty_id TEXT NOT NULL REFERENCES fin_counterparties(id) ON DELETE RESTRICT,
  service TEXT NOT NULL,
  description TEXT,
  plan TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  periodicity TEXT NOT NULL,
  custom_interval_days INTEGER,
  next_charge_at TEXT NOT NULL,
  billing_day INTEGER,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  account_id TEXT REFERENCES fin_accounts(id) ON DELETE SET NULL,
  category_id TEXT NOT NULL REFERENCES fin_categories(id) ON DELETE RESTRICT,
  cost_center_id TEXT REFERENCES fin_cost_centers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  admin_url TEXT,
  responsible_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notice_days INTEGER NOT NULL DEFAULT 7,
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (periodicity IN ('monthly','quarterly','semiannual','annual','custom')),
  CHECK (status IN ('trial','active','suspended','canceled','ended')),
  CHECK (length(service) BETWEEN 2 AND 160),
  CHECK ((periodicity = 'custom') = (custom_interval_days IS NOT NULL))
);
CREATE INDEX fin_subscriptions_status_idx ON fin_subscriptions (status, next_charge_at);
CREATE INDEX fin_subscriptions_counterparty_idx ON fin_subscriptions (counterparty_id);

CREATE TABLE fin_subscription_price_history (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES fin_subscriptions(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX fin_subscription_price_history_sub_idx ON fin_subscription_price_history (subscription_id, effective_at DESC);

CREATE TABLE fin_obligations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  counterparty_id TEXT REFERENCES fin_counterparties(id) ON DELETE RESTRICT,
  category_id TEXT NOT NULL REFERENCES fin_categories(id) ON DELETE RESTRICT,
  cost_center_id TEXT REFERENCES fin_cost_centers(id) ON DELETE SET NULL,
  competency_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  account_id TEXT REFERENCES fin_accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  subscription_id TEXT REFERENCES fin_subscriptions(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  idempotency_key TEXT UNIQUE,
  notes TEXT,
  canceled_at TEXT,
  canceled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind IN ('direct_cost','operating_expense')),
  CHECK (status IN ('open','partial','paid','canceled','reversed')),
  CHECK (source IN ('manual','subscription_charge')),
  CHECK ((source = 'subscription_charge') = (subscription_id IS NOT NULL)),
  CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
);
CREATE INDEX fin_obligations_due_idx ON fin_obligations (status, due_date);
CREATE INDEX fin_obligations_subscription_idx ON fin_obligations (subscription_id);
CREATE INDEX fin_obligations_counterparty_idx ON fin_obligations (counterparty_id);
CREATE INDEX fin_obligations_currency_idx ON fin_obligations (currency);

CREATE TABLE fin_obligation_payments (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES fin_obligations(id) ON DELETE RESTRICT,
  paid_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  account_id TEXT NOT NULL REFERENCES fin_accounts(id) ON DELETE RESTRICT,
  reference TEXT,
  reversal_of TEXT REFERENCES fin_obligation_payments(id) ON DELETE RESTRICT,
  reversal_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (paid_amount_cents <> 0),
  CHECK ((reversal_of IS NOT NULL) = (reversal_reason IS NOT NULL))
);
CREATE INDEX fin_obligation_payments_obligation_idx ON fin_obligation_payments (obligation_id, created_at DESC);
CREATE UNIQUE INDEX fin_obligation_payments_reversal_unique_idx ON fin_obligation_payments (reversal_of) WHERE reversal_of IS NOT NULL;
