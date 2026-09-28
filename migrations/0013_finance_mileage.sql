-- Módulo financeiro (Fase 5): lotes de milhas, fornecedores (fin_counterparties já existente,
-- kind='mileage_provider') e alocação por emissão. Toda compra de lote cria automaticamente uma
-- obrigação de pagamento (fin_obligations, custo direto) na mesma transação — nunca um lote órfão
-- sem registro do que é devido ao fornecedor.

CREATE TABLE fin_mileage_lots (
  id uuid PRIMARY KEY,
  counterparty_id uuid NOT NULL REFERENCES fin_counterparties(id) ON DELETE RESTRICT,
  program text NOT NULL,
  quantity_purchased integer NOT NULL CHECK (quantity_purchased > 0),
  total_cost_cents integer NOT NULL CHECK (total_cost_cents > 0),
  currency char(3) NOT NULL,
  -- Só informativo/exibição (custo médio por milha, em micros de centavo). O custo de cada
  -- alocação é recalculado a partir de total_cost_cents/quantity_purchased no momento da
  -- alocação (shared/mileageCost.ts), nunca a partir deste valor já arredondado — evita
  -- arredondamento composto.
  unit_cost_micros bigint NOT NULL CHECK (unit_cost_micros > 0),
  purchased_at date NOT NULL,
  expires_at date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','depleted','expired','canceled')),
  obligation_id uuid NOT NULL REFERENCES fin_obligations(id) ON DELETE RESTRICT,
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fin_mileage_lots_counterparty_idx ON fin_mileage_lots (counterparty_id, program);
CREATE INDEX fin_mileage_lots_status_idx ON fin_mileage_lots (status);

CREATE TABLE fin_mileage_allocations (
  id uuid PRIMARY KEY,
  lot_id uuid NOT NULL REFERENCES fin_mileage_lots(id) ON DELETE RESTRICT,
  issuance_id uuid NOT NULL REFERENCES fin_issuances(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  -- Congelado no momento da alocação: editar o lote (ex.: nada hoje permite isso, mas o desenho
  -- garante) nunca reprecifica uma alocação já criada.
  cost_cents_snapshot integer NOT NULL CHECK (cost_cents_snapshot >= 0),
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  void_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((voided_at IS NOT NULL) = (void_reason IS NOT NULL))
);
CREATE INDEX fin_mileage_allocations_lot_idx ON fin_mileage_allocations (lot_id);
CREATE INDEX fin_mileage_allocations_issuance_idx ON fin_mileage_allocations (issuance_id);
