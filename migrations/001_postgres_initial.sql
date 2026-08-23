CREATE TABLE IF NOT EXISTS voice_services (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  external_event_type_id INTEGER,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS voice_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','confirming','confirmed','expired','released')),
  provider_reservation_uid TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (tenant_id, service_id) REFERENCES voice_services(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS voice_bookings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  hold_id TEXT REFERENCES voice_holds(id),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed','cancelled','rescheduled','failed')),
  provider_uid TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (tenant_id, service_id) REFERENCES voice_services(tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_booking_slot_unique
  ON voice_bookings(tenant_id, service_id, start_at)
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS voice_holds_lookup
  ON voice_holds(tenant_id, service_id, start_at, status, expires_at);

CREATE TABLE IF NOT EXISTS voice_calls (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  caller TEXT,
  intent TEXT,
  outcome TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  booking_id TEXT,
  transferred BOOLEAN NOT NULL DEFAULT FALSE,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  ai_disclosure BOOLEAN NOT NULL DEFAULT TRUE,
  summary TEXT,
  ended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  call_id TEXT,
  type TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_admins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_admins_email_lower_unique
  ON voice_admins(LOWER(email));

CREATE TABLE IF NOT EXISTS voice_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES voice_admins(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS voice_sessions_expiry
  ON voice_sessions(expires_at);
