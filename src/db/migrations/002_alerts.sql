-- 002_alerts.sql — stretch goal: one-time usage alerts at 80% / 100% of limit.
CREATE TABLE IF NOT EXISTS usage_alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL,
  period        TEXT NOT NULL, -- 'YYYY-MM'
  metric        TEXT NOT NULL CHECK (metric IN ('api_call','token')),
  threshold_pct INTEGER NOT NULL CHECK (threshold_pct IN (80,100)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, period, metric, threshold_pct)
);

CREATE INDEX IF NOT EXISTS idx_alerts_tenant_period ON usage_alerts (tenant_id, period);