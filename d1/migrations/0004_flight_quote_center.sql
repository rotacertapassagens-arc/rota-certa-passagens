ALTER TABLE lead_requests ADD COLUMN protocol TEXT;
ALTER TABLE lead_requests ADD COLUMN customer_name TEXT;
ALTER TABLE lead_requests ADD COLUMN customer_email TEXT;
ALTER TABLE lead_requests ADD COLUMN customer_phone TEXT;
ALTER TABLE lead_requests ADD COLUMN adults INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lead_requests ADD COLUMN children INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lead_requests ADD COLUMN infants INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lead_requests ADD COLUMN cabin_class TEXT;
ALTER TABLE lead_requests ADD COLUMN baggage TEXT;
ALTER TABLE lead_requests ADD COLUMN date_flexibility TEXT;
ALTER TABLE lead_requests ADD COLUMN payment_preference TEXT;
ALTER TABLE lead_requests ADD COLUMN contact_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lead_requests ADD COLUMN assigned_to TEXT;
ALTER TABLE lead_requests ADD COLUMN internal_notes TEXT;
ALTER TABLE lead_requests ADD COLUMN deadline_at TEXT;
ALTER TABLE lead_requests ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX lead_requests_protocol_idx ON lead_requests(protocol) WHERE protocol IS NOT NULL;
CREATE INDEX lead_requests_deadline_idx ON lead_requests(status, deadline_at);
