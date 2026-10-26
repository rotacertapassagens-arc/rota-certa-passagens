-- Financeiro: carteira de milhas própria (saldo por pessoa/CPF e programa), clubes e eventos lidos dos e-mails dos programas.
-- Só acrescenta tabelas; lotes de fornecedor, emissões e vendas existentes não mudam.
-- Milhas com sinal: entrada positiva, saída negativa. O custo acompanha o sinal (custo médio na saída).

CREATE TABLE fin_wallet_accounts (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  program TEXT NOT NULL,
  member_number TEXT,
  cpf_limit INTEGER CHECK (cpf_limit IS NULL OR cpf_limit >= 0),
  reported_balance INTEGER,
  reported_at TEXT,
  reported_source TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (holder, program)
);

CREATE TABLE fin_wallet_movements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fin_wallet_accounts(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('opening','club_credit','purchase','bonus','transfer_in','transfer_out','usage','sale','adjust','expire')),
  miles INTEGER NOT NULL CHECK (miles <> 0),
  cost_cents INTEGER NOT NULL DEFAULT 0,
  occurred_on TEXT NOT NULL,
  expires_on TEXT,
  issuance_id TEXT REFERENCES fin_issuances(id) ON DELETE RESTRICT,
  -- Só no uso em emissão: o custo na moeda da emissão (igual a cost_cents quando a venda é em reais) e o câmbio usado.
  issuance_cost_cents INTEGER,
  fx_rate TEXT,
  event_id TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  voided_at TEXT,
  void_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX fin_wallet_movements_account_idx ON fin_wallet_movements (account_id, occurred_on);
CREATE INDEX fin_wallet_movements_issuance_idx ON fin_wallet_movements (issuance_id);
CREATE UNIQUE INDEX fin_wallet_movements_event_idx ON fin_wallet_movements (event_id) WHERE event_id IS NOT NULL;

CREATE TABLE fin_wallet_clubs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fin_wallet_accounts(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  monthly_miles INTEGER NOT NULL CHECK (monthly_miles >= 0),
  monthly_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_cost_cents >= 0),
  credit_day INTEGER CHECK (credit_day IS NULL OR (credit_day BETWEEN 1 AND 31)),
  card_label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','payment_failed','canceled','paused')),
  last_credit_on TEXT,
  last_event_on TEXT,
  last_event TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX fin_wallet_clubs_account_idx ON fin_wallet_clubs (account_id);

-- Um registro por e-mail de programa lido (source_id = id da mensagem do Gmail, nunca repete).
CREATE TABLE fin_wallet_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('club_credited','club_payment_ok','club_payment_failed','club_canceled','balance')),
  program TEXT NOT NULL,
  holder_hint TEXT,
  member_number TEXT,
  account_id TEXT REFERENCES fin_wallet_accounts(id) ON DELETE SET NULL,
  miles INTEGER,
  balance INTEGER,
  balance_at TEXT,
  plan_name TEXT,
  monthly_cost_cents INTEGER,
  occurred_at TEXT NOT NULL,
  subject TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX fin_wallet_events_account_idx ON fin_wallet_events (account_id, occurred_at);
CREATE INDEX fin_wallet_events_pending_idx ON fin_wallet_events (applied) WHERE applied = 0;
