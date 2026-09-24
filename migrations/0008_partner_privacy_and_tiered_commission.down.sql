ALTER TABLE partner_commissions DROP COLUMN IF EXISTS month_passenger_start_snapshot;
ALTER TABLE partner_commissions DROP COLUMN IF EXISTS passenger_count_snapshot;
ALTER TABLE partner_commissions DROP COLUMN IF EXISTS commission_policy_snapshot;
DROP TABLE IF EXISTS partner_program_settings;
ALTER TABLE partner_applications DROP COLUMN IF EXISTS privacy_consent_at;
ALTER TABLE partner_applications DROP COLUMN IF EXISTS privacy_policy_version;
