ALTER TABLE partner_applications ADD COLUMN privacy_policy_version TEXT;
ALTER TABLE partner_applications ADD COLUMN privacy_consent_at TEXT;
UPDATE partner_applications
   SET privacy_policy_version='2026-09-24', privacy_consent_at=created_at
 WHERE privacy_consent=1;

CREATE TABLE partner_program_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  mode TEXT NOT NULL CHECK (mode IN ('flat','progressive')),
  flat_bps INTEGER NOT NULL,
  tier1_max_passengers INTEGER NOT NULL,
  tier1_bps INTEGER NOT NULL,
  tier2_max_passengers INTEGER NOT NULL,
  tier2_bps INTEGER NOT NULL,
  tier3_max_passengers INTEGER NOT NULL,
  tier3_bps INTEGER NOT NULL,
  tier4_bps INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO partner_program_settings
  (id,mode,flat_bps,tier1_max_passengers,tier1_bps,tier2_max_passengers,tier2_bps,tier3_max_passengers,tier3_bps,tier4_bps)
VALUES (1,'progressive',200,20,200,50,300,100,350,400);

ALTER TABLE partner_commissions ADD COLUMN commission_policy_snapshot TEXT;
ALTER TABLE partner_commissions ADD COLUMN passenger_count_snapshot INTEGER;
ALTER TABLE partner_commissions ADD COLUMN month_passenger_start_snapshot INTEGER;

UPDATE partners
   SET commission_type='percentage',
       commission_fixed_cents=NULL, commission_percentage_bps=200, updated_at=CURRENT_TIMESTAMP
 WHERE code IN ('carlos','tais');
