CREATE TABLE partner_applications (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  email text NOT NULL,
  instagram text,
  whatsapp text,
  privacy_consent boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  partner_id uuid UNIQUE REFERENCES partners(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX partner_applications_pending_email_unique_idx
  ON partner_applications (lower(email)) WHERE status='pending';
CREATE INDEX partner_applications_status_created_idx
  ON partner_applications (status, created_at DESC);
