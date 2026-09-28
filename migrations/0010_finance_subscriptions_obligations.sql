-- Módulo financeiro (Fase 2): assinaturas recorrentes, histórico de reajuste, obrigações
-- (custo direto avulso ou despesa operacional, incluindo cobranças geradas por assinatura) e
-- pagamentos. Nenhum DELETE de linha com histórico: cancelamento/estorno auditado.

CREATE TABLE fin_subscriptions (
  id uuid PRIMARY KEY,
  counterparty_id uuid NOT NULL REFERENCES fin_counterparties(id) ON DELETE RESTRICT,
  service text NOT NULL,
  description text,
  plan text,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL,
  periodicity text NOT NULL CHECK (periodicity IN ('monthly','quarterly','semiannual','annual','custom')),
  custom_interval_days integer CHECK (custom_interval_days IS NULL OR (custom_interval_days > 0 AND custom_interval_days <= 3650)),
  next_charge_at date NOT NULL,
  billing_day integer CHECK (billing_day IS NULL OR (billing_day BETWEEN 1 AND 31)),
  auto_renew boolean NOT NULL DEFAULT true,
  account_id uuid REFERENCES fin_accounts(id) ON DELETE SET NULL,
  category_id uuid NOT NULL REFERENCES fin_categories(id) ON DELETE RESTRICT,
  cost_center_id uuid REFERENCES fin_cost_centers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','suspended','canceled','ended')),
  started_at date NOT NULL,
  ended_at date,
  admin_url text,
  responsible_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  notice_days integer NOT NULL DEFAULT 7 CHECK (notice_days BETWEEN 0 AND 365),
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(service) BETWEEN 2 AND 160),
  CHECK ((periodicity = 'custom') = (custom_interval_days IS NOT NULL))
);
CREATE INDEX fin_subscriptions_status_idx ON fin_subscriptions (status, next_charge_at);
CREATE INDEX fin_subscriptions_counterparty_idx ON fin_subscriptions (counterparty_id);

-- Append-only: a row is inserted on creation and on every reprice, never updated or deleted.
CREATE TABLE fin_subscription_price_history (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES fin_subscriptions(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL,
  effective_at date NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fin_subscription_price_history_sub_idx ON fin_subscription_price_history (subscription_id, effective_at DESC);

CREATE TABLE fin_obligations (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('direct_cost','operating_expense')),
  counterparty_id uuid REFERENCES fin_counterparties(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES fin_categories(id) ON DELETE RESTRICT,
  cost_center_id uuid REFERENCES fin_cost_centers(id) ON DELETE SET NULL,
  competency_date date NOT NULL,
  due_date date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL,
  account_id uuid REFERENCES fin_accounts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','canceled','reversed')),
  -- Only one future-phase link is wired so far (subscription-generated charges). sale_id/
  -- issuance_id/mileage_lot_id are added by later migrations (Fase 3/5) once those tables exist;
  -- each addition must extend the "at most one link filled" CHECK below.
  subscription_id uuid REFERENCES fin_subscriptions(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','subscription_charge')),
  idempotency_key text UNIQUE,
  notes text,
  canceled_at timestamptz,
  canceled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'subscription_charge') = (subscription_id IS NOT NULL)),
  CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
);
CREATE INDEX fin_obligations_due_idx ON fin_obligations (status, due_date);
CREATE INDEX fin_obligations_subscription_idx ON fin_obligations (subscription_id);
CREATE INDEX fin_obligations_counterparty_idx ON fin_obligations (counterparty_id);
CREATE INDEX fin_obligations_currency_idx ON fin_obligations (currency);

CREATE TABLE fin_obligation_payments (
  id uuid PRIMARY KEY,
  obligation_id uuid NOT NULL REFERENCES fin_obligations(id) ON DELETE RESTRICT,
  paid_amount_cents integer NOT NULL CHECK (paid_amount_cents <> 0),
  currency char(3) NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT now(),
  account_id uuid NOT NULL REFERENCES fin_accounts(id) ON DELETE RESTRICT,
  reference text,
  reversal_of uuid REFERENCES fin_obligation_payments(id) ON DELETE RESTRICT,
  reversal_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((reversal_of IS NOT NULL) = (reversal_reason IS NOT NULL))
);
CREATE INDEX fin_obligation_payments_obligation_idx ON fin_obligation_payments (obligation_id, created_at DESC);
-- At most one reversal per original payment (a second reversal attempt is rejected, not silently
-- allowed to double-reverse the same liquidated payment).
CREATE UNIQUE INDEX fin_obligation_payments_reversal_unique_idx ON fin_obligation_payments (reversal_of) WHERE reversal_of IS NOT NULL;
