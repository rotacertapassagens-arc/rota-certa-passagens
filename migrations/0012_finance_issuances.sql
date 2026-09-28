-- Módulo financeiro (Fase 4): emissões, custos diretos e lucro por venda. Uma emissão pertence
-- sempre a uma fin_sales existente. Custo de milhas nesta fase é um valor informado manualmente
-- (miles_cost_cents) — a Fase 5 substitui esse valor por um snapshot derivado de alocação real de
-- lotes de milhas (fin_mileage_allocations), sem quebrar o que já existe aqui.

CREATE TABLE fin_issuances (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES fin_sales(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('cash','miles','hybrid','consolidator','airline','other')),
  airline text,
  loyalty_program text,
  pnr text,
  ticket_numbers text,
  currency char(3) NOT NULL,
  cash_amount_cents integer NOT NULL DEFAULT 0 CHECK (cash_amount_cents >= 0),
  miles_quantity integer NOT NULL DEFAULT 0 CHECK (miles_quantity >= 0),
  miles_cost_cents integer NOT NULL DEFAULT 0 CHECK (miles_cost_cents >= 0),
  airport_fees_cents integer NOT NULL DEFAULT 0 CHECK (airport_fees_cents >= 0),
  issuance_fee_cents integer NOT NULL DEFAULT 0 CHECK (issuance_fee_cents >= 0),
  consolidator_fee_cents integer NOT NULL DEFAULT 0 CHECK (consolidator_fee_cents >= 0),
  gateway_fee_cents integer NOT NULL DEFAULT 0 CHECK (gateway_fee_cents >= 0),
  -- Comissão do agente/atendente que emitiu, nunca a comissão de indicação de partner_commissions
  -- (tabela e conceito totalmente separados — ver docs/financeiro/MODELO_DADOS.md).
  agent_commission_cents integer NOT NULL DEFAULT 0 CHECK (agent_commission_cents >= 0),
  other_costs_cents integer NOT NULL DEFAULT 0 CHECK (other_costs_cents >= 0),
  mileage_provider_id uuid REFERENCES fin_counterparties(id) ON DELETE SET NULL,
  consolidator_id uuid REFERENCES fin_counterparties(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','issued','canceled','refunded')),
  issued_at timestamptz,
  issued_by uuid REFERENCES users(id) ON DELETE SET NULL,
  terminated_at timestamptz,
  terminated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  termination_reason text,
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('issued','refunded')) = (issued_at IS NOT NULL)),
  CHECK ((status IN ('canceled','refunded')) = (terminated_at IS NOT NULL))
);
CREATE INDEX fin_issuances_sale_idx ON fin_issuances (sale_id);
CREATE INDEX fin_issuances_status_idx ON fin_issuances (status);
