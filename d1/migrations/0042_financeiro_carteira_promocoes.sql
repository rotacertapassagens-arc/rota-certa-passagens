-- Financeiro: controle das promoções feitas em cada conta da carteira (ex.: Livelo para LATAM Turbo, uma vez por mês).
-- Só acrescenta uma tabela; as milhas continuam entrando pelos lançamentos e pelo "Conferir saldo".
-- O mês vem da data em que a promoção foi feita (YYYY-MM) e serve para ver quem já fez e quem ainda pode fazer.

CREATE TABLE fin_wallet_promos (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fin_wallet_accounts(id) ON DELETE RESTRICT,
  promo_name TEXT NOT NULL,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  done_on TEXT NOT NULL,
  points_sent INTEGER CHECK (points_sent IS NULL OR points_sent > 0),
  bonus_percent INTEGER CHECK (bonus_percent IS NULL OR bonus_percent BETWEEN 0 AND 1000),
  miles_received INTEGER CHECK (miles_received IS NULL OR miles_received > 0),
  note TEXT,
  voided_at TEXT,
  void_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX fin_wallet_promos_account_idx ON fin_wallet_promos (account_id, month);
