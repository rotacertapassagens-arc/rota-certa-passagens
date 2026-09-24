ALTER TABLE partner_applications ADD COLUMN privacy_policy_version text;
ALTER TABLE partner_applications ADD COLUMN privacy_consent_at timestamptz;
UPDATE partner_applications
   SET privacy_policy_version='2026-09-24', privacy_consent_at=created_at
 WHERE privacy_consent=true;
ALTER TABLE partner_applications ALTER COLUMN privacy_policy_version SET NOT NULL;
ALTER TABLE partner_applications ALTER COLUMN privacy_consent_at SET NOT NULL;

CREATE TABLE partner_program_settings (
  id smallint PRIMARY KEY CHECK (id=1),
  mode text NOT NULL CHECK (mode IN ('flat','progressive')),
  flat_bps integer NOT NULL CHECK (flat_bps BETWEEN 0 AND 10000),
  tier1_max_passengers integer NOT NULL CHECK (tier1_max_passengers > 0),
  tier1_bps integer NOT NULL CHECK (tier1_bps BETWEEN 0 AND 10000),
  tier2_max_passengers integer NOT NULL,
  tier2_bps integer NOT NULL CHECK (tier2_bps BETWEEN 0 AND 10000),
  tier3_max_passengers integer NOT NULL,
  tier3_bps integer NOT NULL CHECK (tier3_bps BETWEEN 0 AND 10000),
  tier4_bps integer NOT NULL CHECK (tier4_bps BETWEEN 0 AND 10000),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (tier1_max_passengers < tier2_max_passengers AND tier2_max_passengers < tier3_max_passengers)
);
INSERT INTO partner_program_settings
  (id,mode,flat_bps,tier1_max_passengers,tier1_bps,tier2_max_passengers,tier2_bps,tier3_max_passengers,tier3_bps,tier4_bps)
VALUES (1,'progressive',200,20,200,50,300,100,350,400);

ALTER TABLE partner_commissions ADD COLUMN commission_policy_snapshot jsonb;
ALTER TABLE partner_commissions ADD COLUMN passenger_count_snapshot integer
  CHECK (passenger_count_snapshot IS NULL OR passenger_count_snapshot > 0);
ALTER TABLE partner_commissions ADD COLUMN month_passenger_start_snapshot integer
  CHECK (month_passenger_start_snapshot IS NULL OR month_passenger_start_snapshot > 0);

-- The two internal partners have no commission history yet, so the new universal progressive
-- rule can safely become their rule without rewriting any financial fact.
UPDATE partners
   SET commission_type='percentage',
       commission_fixed_cents=NULL, commission_percentage_bps=200, updated_at=now()
 WHERE code IN ('carlos','tais');
