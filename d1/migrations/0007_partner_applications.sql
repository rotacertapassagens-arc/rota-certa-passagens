CREATE TABLE partner_applications (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  instagram TEXT,
  whatsapp TEXT,
  privacy_consent INTEGER NOT NULL CHECK (privacy_consent IN (0,1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  partner_id TEXT UNIQUE REFERENCES partners(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX partner_applications_pending_email_unique_idx
  ON partner_applications (lower(email)) WHERE status='pending';
CREATE INDEX partner_applications_status_created_idx
  ON partner_applications (status, created_at DESC);
