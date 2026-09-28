PRAGMA foreign_keys = ON;

-- Mirrors migrations/0013_finance_mileage.sql in SQLite/D1 dialect. SQLite INTEGER is already
-- 64-bit, so unit_cost_micros needs no special type (unlike Postgres, where it must be bigint).

CREATE TABLE fin_mileage_lots (
  id TEXT PRIMARY KEY,
  counterparty_id TEXT NOT NULL REFERENCES fin_counterparties(id) ON DELETE RESTRICT,
  program TEXT NOT NULL,
  quantity_purchased INTEGER NOT NULL,
  total_cost_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  unit_cost_micros INTEGER NOT NULL,
  purchased_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  obligation_id TEXT NOT NULL REFERENCES fin_obligations(id) ON DELETE RESTRICT,
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (quantity_purchased > 0),
  CHECK (total_cost_cents > 0),
  CHECK (unit_cost_micros > 0),
  CHECK (status IN ('active','depleted','expired','canceled'))
);
CREATE INDEX fin_mileage_lots_counterparty_idx ON fin_mileage_lots (counterparty_id, program);
CREATE INDEX fin_mileage_lots_status_idx ON fin_mileage_lots (status);

CREATE TABLE fin_mileage_allocations (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES fin_mileage_lots(id) ON DELETE RESTRICT,
  issuance_id TEXT NOT NULL REFERENCES fin_issuances(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  cost_cents_snapshot INTEGER NOT NULL,
  voided_at TEXT,
  voided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (quantity > 0),
  CHECK (cost_cents_snapshot >= 0),
  CHECK ((voided_at IS NOT NULL) = (void_reason IS NOT NULL))
);
CREATE INDEX fin_mileage_allocations_lot_idx ON fin_mileage_allocations (lot_id);
CREATE INDEX fin_mileage_allocations_issuance_idx ON fin_mileage_allocations (issuance_id);
