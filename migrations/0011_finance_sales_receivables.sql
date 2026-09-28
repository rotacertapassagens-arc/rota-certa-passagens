-- Módulo financeiro (Fase 3): vendas e contas a receber. Uma venda financeira (fin_sales) sempre
-- nasce de uma proposta (lead_requests) já convertida pelo fluxo existente do painel master
-- (PATCH /api/admin/leads/:id) — este módulo NUNCA recria a lógica de conversão, comissão de
-- parceiro ou auditoria já existentes em lead_requests/partner_commissions; apenas referencia e
-- adiciona o detalhamento financeiro (parcelas, recebimentos) que aquelas tabelas não têm.

CREATE TABLE fin_sales (
  id uuid PRIMARY KEY,
  lead_request_id uuid NOT NULL UNIQUE REFERENCES lead_requests(id) ON DELETE RESTRICT,
  protocol text NOT NULL,
  sale_date date NOT NULL,
  currency char(3) NOT NULL,
  gross_amount_cents integer NOT NULL CHECK (gross_amount_cents > 0),
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  net_amount_cents integer NOT NULL CHECK (net_amount_cents > 0),
  passenger_count integer CHECK (passenger_count IS NULL OR passenger_count > 0),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  partner_id uuid REFERENCES partners(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','canceled','refunded')),
  internal_notes text,
  -- Shared by both terminal transitions (cancel and refund) rather than a canceled_at/refunded_at
  -- pair, since a sale can reach exactly one terminal state and never both.
  terminated_at timestamptz,
  terminated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  termination_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (net_amount_cents = gross_amount_cents - discount_cents),
  CHECK ((status IN ('canceled','refunded')) = (terminated_at IS NOT NULL))
);
CREATE INDEX fin_sales_status_idx ON fin_sales (status, sale_date);
CREATE INDEX fin_sales_partner_idx ON fin_sales (partner_id);

CREATE TABLE fin_receivables (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES fin_sales(id) ON DELETE RESTRICT,
  installment_number integer NOT NULL CHECK (installment_number >= 1),
  due_date date NOT NULL,
  expected_amount_cents integer NOT NULL CHECK (expected_amount_cents > 0),
  currency char(3) NOT NULL,
  account_id uuid REFERENCES fin_accounts(id) ON DELETE SET NULL,
  method text NOT NULL CHECK (method IN ('pix','transfer','card','cash','boleto','other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','canceled','refunded')),
  canceled_at timestamptz,
  canceled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sale_id, installment_number),
  CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
);
CREATE INDEX fin_receivables_due_idx ON fin_receivables (status, due_date);
CREATE INDEX fin_receivables_sale_idx ON fin_receivables (sale_id);
CREATE INDEX fin_receivables_currency_idx ON fin_receivables (currency);

CREATE TABLE fin_receivable_payments (
  id uuid PRIMARY KEY,
  receivable_id uuid NOT NULL REFERENCES fin_receivables(id) ON DELETE RESTRICT,
  received_amount_cents integer NOT NULL CHECK (received_amount_cents <> 0),
  currency char(3) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  account_id uuid NOT NULL REFERENCES fin_accounts(id) ON DELETE RESTRICT,
  gateway_fee_cents integer CHECK (gateway_fee_cents IS NULL OR gateway_fee_cents >= 0),
  reference text,
  reversal_of uuid REFERENCES fin_receivable_payments(id) ON DELETE RESTRICT,
  reversal_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((reversal_of IS NOT NULL) = (reversal_reason IS NOT NULL))
);
CREATE INDEX fin_receivable_payments_receivable_idx ON fin_receivable_payments (receivable_id, created_at DESC);
CREATE UNIQUE INDEX fin_receivable_payments_reversal_unique_idx ON fin_receivable_payments (reversal_of) WHERE reversal_of IS NOT NULL;
