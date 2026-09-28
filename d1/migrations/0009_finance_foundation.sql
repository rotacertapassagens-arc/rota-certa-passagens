PRAGMA foreign_keys = ON;

-- Módulo financeiro (Fase 1 — fundação). Mesma forma de migrations/0009_finance_foundation.sql
-- em dialeto SQLite/D1: booleano como INTEGER 0/1, datas como TEXT, sem índice funcional
-- lower(name) porque D1 não garante paridade de collation com o unique index do Postgres —
-- a checagem de nome duplicado (case-insensitive) fica a cargo da aplicação nesta rota, igual ao
-- padrão já usado para "code = lower(code)" em partners.

CREATE TABLE fin_cost_centers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(name) BETWEEN 2 AND 120)
);
CREATE UNIQUE INDEX fin_cost_centers_name_idx ON fin_cost_centers (name);

CREATE TABLE fin_categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES fin_categories(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  default_cost_center_id TEXT REFERENCES fin_cost_centers(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind IN ('revenue','direct_cost','operating_expense')),
  CHECK (length(name) BETWEEN 2 AND 120)
);
CREATE INDEX fin_categories_parent_idx ON fin_categories (parent_id);
CREATE INDEX fin_categories_kind_idx ON fin_categories (kind, active);

CREATE TABLE fin_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  institution TEXT,
  last4 TEXT,
  currency TEXT NOT NULL,
  opening_balance_cents INTEGER,
  opening_balance_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (type IN ('bank','cash','card','digital_wallet','other')),
  CHECK (length(name) BETWEEN 2 AND 120),
  CHECK (last4 IS NULL OR (length(last4) = 4)),
  CHECK ((opening_balance_cents IS NULL) = (opening_balance_at IS NULL))
);
CREATE INDEX fin_accounts_active_idx ON fin_accounts (active);

CREATE TABLE fin_counterparties (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  tax_id TEXT,
  contact TEXT,
  preferred_currency TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind IN ('supplier','airline','consolidator','mileage_provider','other')),
  CHECK (length(display_name) BETWEEN 2 AND 160)
);
CREATE INDEX fin_counterparties_kind_idx ON fin_counterparties (kind, active);
