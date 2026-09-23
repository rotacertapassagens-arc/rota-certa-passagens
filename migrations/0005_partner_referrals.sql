-- Partner referral program: partners, clicks, lead attribution, commissions, notification outbox.

-- The original 0001 migration left these CHECK constraints unnamed, so Postgres assigned the
-- standard "<table>_<column>_check" name. Some local SQL engines used only in this repo's test
-- suite (pg-mem) generate a different internal name for the very same unnamed constraint, so
-- both spellings are dropped defensively (IF EXISTS) to keep the migration itself in exact sync
-- across every environment it actually runs against.
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_constraint_1;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN ('customer','master','partner'));

ALTER TABLE account_tokens DROP CONSTRAINT IF EXISTS account_tokens_purpose_check;
ALTER TABLE account_tokens DROP CONSTRAINT IF EXISTS account_tokens_constraint_1;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_purpose_check
  CHECK (purpose IN ('email_verification','password_reset','master_invite','partner_invite'));

CREATE TABLE partners (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  instagram text,
  whatsapp text,
  email text NOT NULL,
  commission_type text NOT NULL CHECK (commission_type IN ('fixed','percentage')),
  commission_fixed_cents integer CHECK (commission_fixed_cents IS NULL OR commission_fixed_cents >= 0),
  commission_percentage_bps integer CHECK (commission_percentage_bps IS NULL OR (commission_percentage_bps > 0 AND commission_percentage_bps <= 10000)),
  currency char(3) NOT NULL DEFAULT 'EUR',
  attribution_window_days integer NOT NULL DEFAULT 30 CHECK (attribution_window_days > 0 AND attribution_window_days <= 365),
  active boolean NOT NULL DEFAULT true,
  user_id uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (commission_type='fixed' AND commission_fixed_cents IS NOT NULL AND commission_percentage_bps IS NULL) OR
    (commission_type='percentage' AND commission_percentage_bps IS NOT NULL AND commission_fixed_cents IS NULL)
  ),
  CHECK (code = lower(code)),
  CHECK (char_length(code) BETWEEN 3 AND 32)
);
CREATE INDEX partners_active_idx ON partners(active);

CREATE TABLE referral_clicks (
  id uuid PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  clicked_at timestamptz NOT NULL DEFAULT now(),
  landing_path text NOT NULL DEFAULT '/proposta-voo.html',
  visitor_hash char(64),
  ip_hash char(64),
  user_agent text
);
CREATE INDEX referral_clicks_partner_idx ON referral_clicks(partner_id, clicked_at DESC);

ALTER TABLE lead_requests ADD COLUMN partner_id uuid REFERENCES partners(id) ON DELETE SET NULL;
ALTER TABLE lead_requests ADD COLUMN referral_code_snapshot text;
ALTER TABLE lead_requests ADD COLUMN referral_source text NOT NULL DEFAULT 'none' CHECK (referral_source IN ('link','manual','none'));
ALTER TABLE lead_requests ADD COLUMN referral_captured_at timestamptz;
ALTER TABLE lead_requests ADD COLUMN attribution_expires_at timestamptz;
ALTER TABLE lead_requests ADD COLUMN sale_amount_cents integer CHECK (sale_amount_cents IS NULL OR sale_amount_cents >= 0);
ALTER TABLE lead_requests ADD COLUMN sale_currency char(3);
ALTER TABLE lead_requests ADD COLUMN converted_at timestamptz;
CREATE INDEX lead_requests_partner_idx ON lead_requests(partner_id, created_at DESC);

CREATE TABLE partner_commissions (
  id uuid PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  lead_request_id uuid NOT NULL UNIQUE REFERENCES lead_requests(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','void')),
  commission_type_snapshot text NOT NULL CHECK (commission_type_snapshot IN ('fixed','percentage')),
  commission_rate_snapshot integer NOT NULL,
  sale_amount_cents_snapshot integer,
  void_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at timestamptz,
  paid_by uuid REFERENCES users(id) ON DELETE SET NULL,
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_commissions_partner_idx ON partner_commissions(partner_id, status);

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  event_type text NOT NULL CHECK (event_type IN ('referral_confirmed','proposal_converted','commission_paid','weekly_summary')),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','whatsapp')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_outbox_pending_idx ON notification_outbox(status, next_attempt_at);
