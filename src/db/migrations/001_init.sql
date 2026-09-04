-- 001_init.sql — Usage Metering & Billing Engine schema
-- Money and costs are stored as INTEGER micro-units (1 USD = 1,000,000 micro-units). No floats anywhere.

CREATE TABLE IF NOT EXISTS plans (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  api_call_limit  INTEGER NOT NULL,
  token_limit     INTEGER NOT NULL,
  price_cents     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tenants (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  api_key             TEXT NOT NULL UNIQUE,
  plan_id             TEXT NOT NULL REFERENCES plans(id),
  status              TEXT NOT NULL DEFAULT 'active',      -- active | suspended
  stripe_customer_id  TEXT UNIQUE,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(id),
  plan_id                TEXT NOT NULL REFERENCES plans(id),
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id     TEXT,
  status                 TEXT NOT NULL DEFAULT 'incomplete', -- active | trialing | past_due | incomplete | canceled
  current_period_start   TEXT,
  current_period_end     TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per usage event. idempotency_key is UNIQUE: re-sending the same key
-- cannot store a second event (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS usage_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('api_call','input','cached_input','output','reasoning')),
  quantity        INTEGER NOT NULL CHECK (quantity >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  recorded_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_tenant_time      ON usage_events (tenant_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_type_time ON usage_events (tenant_id, type, recorded_at);

-- Mirrors the original response for a given idempotency key so a duplicate
-- request returns the exact original result.
CREATE TABLE IF NOT EXISTS request_responses (
  idempotency_key TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  response        TEXT NOT NULL, -- JSON
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Stripe webhook event deduplication: the event id is the primary key.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Nightly / period rollup cache (computed by the background rollup job).
CREATE TABLE IF NOT EXISTS usage_rollups (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id           TEXT NOT NULL,
  period              TEXT NOT NULL, -- 'YYYY-MM' (UTC)
  api_calls           INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_micros         INTEGER NOT NULL DEFAULT 0,
  computed_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, period)
);

CREATE INDEX IF NOT EXISTS idx_rollup_tenant_period ON usage_rollups (tenant_id, period);