DROP TABLE IF EXISTS notification_outbox;
DROP TABLE IF EXISTS partner_commissions;

ALTER TABLE lead_requests DROP COLUMN IF EXISTS converted_at;
ALTER TABLE lead_requests DROP COLUMN IF EXISTS sale_currency;
ALTER TABLE lead_requests DROP COLUMN IF EXISTS sale_amount_cents;
ALTER TABLE lead_requests DROP COLUMN IF EXISTS attribution_expires_at;
ALTER TABLE lead_requests DROP COLUMN IF EXISTS referral_captured_at;
ALTER TABLE lead_requests DROP COLUMN IF EXISTS referral_source;
ALTER TABLE lead_requests DROP COLUMN IF EXISTS referral_code_snapshot;
ALTER TABLE lead_requests DROP COLUMN IF EXISTS partner_id;

DROP TABLE IF EXISTS referral_clicks CASCADE;
DROP TABLE IF EXISTS partners CASCADE;

ALTER TABLE account_tokens DROP CONSTRAINT IF EXISTS account_tokens_purpose_check;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_purpose_check
  CHECK (purpose IN ('email_verification','password_reset','master_invite'));

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN ('customer','master'));
