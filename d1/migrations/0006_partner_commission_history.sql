PRAGMA foreign_keys = OFF;

-- 1) Commission history: a lead can have more than one historical commission row (converted ->
--    voided -> reconverted) but at most one non-voided one at a time. SQLite cannot drop or
--    alter an inline column constraint, so the table is recreated without the old UNIQUE on
--    lead_request_id, then a partial unique index enforces the new, narrower rule.
CREATE TABLE partner_commissions_new (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  lead_request_id TEXT NOT NULL REFERENCES lead_requests(id) ON DELETE RESTRICT,
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
INSERT INTO partner_commissions_new SELECT * FROM partner_commissions;
DROP TABLE partner_commissions;
ALTER TABLE partner_commissions_new RENAME TO partner_commissions;
CREATE INDEX partner_commissions_partner_idx ON partner_commissions(partner_id, status);
CREATE INDEX partner_commissions_lead_request_idx ON partner_commissions(lead_request_id, created_at DESC);
CREATE UNIQUE INDEX partner_commissions_active_unique_idx ON partner_commissions(lead_request_id) WHERE status <> 'void';

-- 2) A partner's email is the join key the invite flow uses to attach a user account; without a
--    uniqueness guarantee two partner rows could race to claim the same account.
CREATE UNIQUE INDEX partners_email_unique_idx ON partners(lower(email));

-- 3) Outbox claim/lease: recreated to widen the status CHECK to include 'processing' and add the
--    lock token + lease expiry columns two concurrent processors need to avoid double-sending.
CREATE TABLE notification_outbox_new (
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
  lock_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (event_type IN ('referral_confirmed','proposal_converted','commission_paid','weekly_summary')),
  CHECK (channel IN ('email','whatsapp')),
  CHECK (status IN ('pending','processing','sent','failed','skipped'))
);
INSERT INTO notification_outbox_new (id,idempotency_key,event_type,partner_id,channel,payload,status,attempts,next_attempt_at,last_error,created_at,updated_at)
  SELECT id,idempotency_key,event_type,partner_id,channel,payload,status,attempts,next_attempt_at,last_error,created_at,updated_at FROM notification_outbox;
DROP TABLE notification_outbox;
ALTER TABLE notification_outbox_new RENAME TO notification_outbox;
CREATE INDEX notification_outbox_pending_idx ON notification_outbox(status, next_attempt_at);
CREATE INDEX notification_outbox_claimable_idx ON notification_outbox(status, next_attempt_at, lease_expires_at);

PRAGMA foreign_keys = ON;

-- NOTE (documented gap, see report): unlike the Postgres migration, this migration does not add
-- CHECK(currency IN (...)) constraints to partners/lead_requests/partner_commissions, because
-- doing so on partners and lead_requests would require recreating those two larger, more heavily
-- referenced tables in SQLite (no ALTER ... ADD CONSTRAINT). Currency is validated by the
-- allowlist in worker/index.ts (mirrors src/security.ts's ALLOWED_CURRENCIES) at the application
-- layer only on this backend. Tracked as a follow-up before this parity gap should block
-- production sign-off.
