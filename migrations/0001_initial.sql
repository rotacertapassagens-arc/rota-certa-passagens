CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  country_code text CHECK (country_code IS NULL OR char_length(country_code)=2),
  locale text NOT NULL DEFAULT 'pt-BR',
  timezone text NOT NULL DEFAULT 'Europe/Lisbon',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('customer','master')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip_hash char(64),
  user_agent text
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE account_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('email_verification','password_reset','master_invite')),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_lookup_idx ON account_tokens(user_id, purpose, expires_at) WHERE used_at IS NULL;

CREATE TABLE plans (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  price_cents integer,
  currency char(3) NOT NULL DEFAULT 'EUR',
  duration_days integer,
  checkout_enabled boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (price_cents IS NULL OR price_cents >= 0),
  CHECK (duration_days IS NULL OR duration_days > 0)
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  status text NOT NULL CHECK (status IN ('trialing','active','expired','canceled','pending')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  provider text,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX subscriptions_user_access_idx ON subscriptions(user_id, status, ends_at);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id uuid REFERENCES plans(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','paid','failed','canceled','refunded')),
  provider text NOT NULL,
  provider_reference text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_user_idx ON payments(user_id, created_at DESC);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('received','processed','ignored','failed')),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE email_events (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  template text NOT NULL,
  recipient_hash char(64) NOT NULL,
  provider text NOT NULL,
  provider_reference text,
  status text NOT NULL CHECK (status IN ('captured','queued','sent','failed','suppressed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_requests (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('flight_quote','planning')),
  origin text,
  destination text,
  outbound_on date,
  return_on date,
  passengers text,
  trip_type text,
  notes text,
  status text NOT NULL DEFAULT 'new' CONSTRAINT lead_requests_status_check CHECK (status IN ('new','reviewing','closed')),
  ip_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_requests_status_idx ON lead_requests(status, created_at DESC);

CREATE TABLE trips (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  destination text,
  starts_on date,
  ends_on date,
  travelers integer NOT NULL DEFAULT 1 CHECK (travelers > 0 AND travelers <= 100),
  timezone text NOT NULL DEFAULT 'Europe/Lisbon',
  source text NOT NULL DEFAULT 'native' CHECK (source IN ('native','local_import','staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX trips_owner_idx ON trips(owner_user_id, updated_at DESC);

CREATE TABLE itinerary_items (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_number integer NOT NULL CHECK (day_number > 0),
  starts_at time,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'Atividade',
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX itinerary_owner_trip_idx ON itinerary_items(owner_user_id, trip_id, day_number, sort_order);

CREATE TABLE places (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'Outro',
  address text,
  notes text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX places_owner_trip_idx ON places(owner_user_id, trip_id);

CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL,
  title text NOT NULL,
  reference_code text,
  starts_at timestamptz,
  address text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservations_owner_trip_idx ON reservations(owner_user_id, trip_id);

CREATE TABLE trip_links (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trip_links_owner_trip_idx ON trip_links(owner_user_id, trip_id);

CREATE TABLE trip_notes (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trip_notes_owner_trip_idx ON trip_notes(owner_user_id, trip_id);

CREATE TABLE budgets (
  trip_id uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budgets_owner_idx ON budgets(owner_user_id);

CREATE TABLE expenses (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL,
  description text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  spent_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_owner_trip_idx ON expenses(owner_user_id, trip_id, created_at DESC);

CREATE TABLE checklist_items (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text text NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checklist_owner_trip_idx ON checklist_items(owner_user_id, trip_id, sort_order);

CREATE TABLE rate_limit_buckets (
  key_hash char(64) PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  blocked_until timestamptz
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id uuid,
  ip_hash char(64),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor_idx ON audit_events(actor_user_id, created_at DESC);

INSERT INTO plans (id, code, name, price_cents, currency, duration_days, checkout_enabled)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'trial-10d', 'Teste do Planner', 0, 'EUR', 10, false),
  ('00000000-0000-4000-8000-000000000002', 'planner-30d', 'Rota Certa Planner', 999, 'EUR', 30, true),
  ('00000000-0000-4000-8000-000000000003', 'personalized', 'Planejamento personalizado', NULL, 'EUR', NULL, false);

INSERT INTO schema_migrations (version) VALUES ('0001_initial');
