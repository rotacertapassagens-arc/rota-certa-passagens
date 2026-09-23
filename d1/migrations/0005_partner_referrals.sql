PRAGMA foreign_keys = ON;

CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  instagram TEXT,
  whatsapp TEXT,
  email TEXT NOT NULL,
  commission_type TEXT NOT NULL,
  commission_fixed_cents INTEGER,
  commission_percentage_bps INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  attribution_window_days INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (commission_type IN ('fixed','percentage')),
  CHECK (
    (commission_type='fixed' AND commission_fixed_cents IS NOT NULL AND commission_percentage_bps IS NULL) OR
    (commission_type='percentage' AND commission_percentage_bps IS NOT NULL AND commission_fixed_cents IS NULL)
  ),
  CHECK (code = lower(code)),
  CHECK (length(code) BETWEEN 3 AND 32)
);
CREATE INDEX partners_active_idx ON partners(active);

CREATE TABLE referral_clicks (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  clicked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  landing_path TEXT NOT NULL DEFAULT '/proposta-voo.html',
  visitor_hash TEXT,
  ip_hash TEXT,
  user_agent TEXT
);
CREATE INDEX referral_clicks_partner_idx ON referral_clicks(partner_id, clicked_at DESC);

ALTER TABLE lead_requests ADD COLUMN partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL;
ALTER TABLE lead_requests ADD COLUMN referral_code_snapshot TEXT;
ALTER TABLE lead_requests ADD COLUMN referral_source TEXT NOT NULL DEFAULT 'none';
ALTER TABLE lead_requests ADD COLUMN referral_captured_at TEXT;
ALTER TABLE lead_requests ADD COLUMN attribution_expires_at TEXT;
ALTER TABLE lead_requests ADD COLUMN sale_amount_cents INTEGER;
ALTER TABLE lead_requests ADD COLUMN sale_currency TEXT;
ALTER TABLE lead_requests ADD COLUMN converted_at TEXT;
CREATE INDEX lead_requests_partner_idx ON lead_requests(partner_id, created_at DESC);

CREATE TABLE partner_commissions (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  lead_request_id TEXT NOT NULL UNIQUE REFERENCES lead_requests(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  commission_type_snapshot TEXT NOT NULL,
  commission_rate_snapshot INTEGER NOT NULL,
  sale_amount_cents_snapshot INTEGER,
  void_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  paid_at TEXT,
  paid_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  voided_at TEXT,
  voided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('pending','approved','paid','void'))
);
CREATE INDEX partner_commissions_partner_idx ON partner_commissions(partner_id, status);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  partner_id TEXT REFERENCES partners(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'email',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (event_type IN ('referral_confirmed','proposal_converted','commission_paid','weekly_summary')),
  CHECK (channel IN ('email','whatsapp')),
  CHECK (status IN ('pending','sent','failed','skipped'))
);
CREATE INDEX notification_outbox_pending_idx ON notification_outbox(status, next_attempt_at);
