ALTER TABLE lead_requests ADD COLUMN protocol text UNIQUE;
ALTER TABLE lead_requests ADD COLUMN customer_name text;
ALTER TABLE lead_requests ADD COLUMN customer_email text;
ALTER TABLE lead_requests ADD COLUMN customer_phone text;
ALTER TABLE lead_requests ADD COLUMN adults integer NOT NULL DEFAULT 1 CHECK (adults BETWEEN 1 AND 20);
ALTER TABLE lead_requests ADD COLUMN children integer NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 20);
ALTER TABLE lead_requests ADD COLUMN infants integer NOT NULL DEFAULT 0 CHECK (infants BETWEEN 0 AND 20);
ALTER TABLE lead_requests ADD COLUMN cabin_class text;
ALTER TABLE lead_requests ADD COLUMN baggage text;
ALTER TABLE lead_requests ADD COLUMN date_flexibility text;
ALTER TABLE lead_requests ADD COLUMN payment_preference text;
ALTER TABLE lead_requests ADD COLUMN contact_consent boolean NOT NULL DEFAULT false;
ALTER TABLE lead_requests ADD COLUMN assigned_to uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lead_requests ADD COLUMN internal_notes text;
ALTER TABLE lead_requests ADD COLUMN deadline_at timestamptz;
ALTER TABLE lead_requests ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE lead_requests DROP CONSTRAINT lead_requests_status_check;
ALTER TABLE lead_requests ADD CONSTRAINT lead_requests_status_check
  CHECK (status IN ('new','reviewing','awaiting_customer','ready','sent','converted','lost','canceled','closed'));

CREATE UNIQUE INDEX lead_requests_protocol_idx ON lead_requests(protocol) WHERE protocol IS NOT NULL;
CREATE INDEX lead_requests_deadline_idx ON lead_requests(status, deadline_at);
