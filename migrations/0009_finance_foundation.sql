-- Módulo financeiro (Fase 1 — fundação): categorias, centros de custo, contas internas e
-- contrapartes. Prefixo fin_ em todas as tabelas para não colidir com o domínio do Planner do
-- cliente (que já usa "expenses"/"budgets" para outro propósito). Nenhum dado real é inserido
-- aqui; sem hard delete: toda entidade tem "active" e nunca é removida via DELETE.

CREATE TABLE fin_cost_centers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 2 AND 120)
);
CREATE UNIQUE INDEX fin_cost_centers_name_idx ON fin_cost_centers (lower(name));

CREATE TABLE fin_categories (
  id uuid PRIMARY KEY,
  parent_id uuid REFERENCES fin_categories(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('revenue','direct_cost','operating_expense')),
  name text NOT NULL,
  default_cost_center_id uuid REFERENCES fin_cost_centers(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 2 AND 120)
);
CREATE INDEX fin_categories_parent_idx ON fin_categories (parent_id);
CREATE INDEX fin_categories_kind_idx ON fin_categories (kind, active);

CREATE TABLE fin_accounts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('bank','cash','card','digital_wallet','other')),
  institution text,
  last4 char(4),
  currency char(3) NOT NULL,
  opening_balance_cents integer,
  opening_balance_at date,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 2 AND 120),
  -- Only the length is checked here (digit-only is enforced by the API's zod schema): pg-mem,
  -- this repo's default test engine, does not implement the `~` regex operator (see db.ts's
  -- note on pg-mem limitations for the same kind of portability constraint elsewhere).
  CHECK (last4 IS NULL OR char_length(last4) = 4),
  CHECK ((opening_balance_cents IS NULL) = (opening_balance_at IS NULL))
);
CREATE INDEX fin_accounts_active_idx ON fin_accounts (active);

CREATE TABLE fin_counterparties (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('supplier','airline','consolidator','mileage_provider','other')),
  tax_id text,
  contact text,
  preferred_currency char(3),
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(display_name) BETWEEN 2 AND 160)
);
CREATE INDEX fin_counterparties_kind_idx ON fin_counterparties (kind, active);
