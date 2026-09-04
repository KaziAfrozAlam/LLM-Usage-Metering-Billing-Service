// Usage alerts (stretch goal): notify once when a tenant crosses 80% and 100%
// of its monthly quota, per metric (API calls and AI tokens), per period.
// Deduped by UNIQUE (tenant_id, period, metric, threshold_pct) so each
// threshold fires exactly once per calendar month.

const { totalsByType } = require('./meterService');

const ALERT_THRESHOLDS = [80, 100];
const METRICS = ['api_call', 'token'];

/**
 * Evaluate alerts for a tenant's current period and persist any newly-crossed
 * thresholds. Returns the alerts that just fired ([]) if none.
 */
function evaluateAlerts(db, tenant, period) {
  const totals = totalsByType(db, tenant.id, period);
  const tokenUsed = totals.input + totals.cached_input + totals.output + totals.reasoning;
  const usage = { api_call: totals.api_call, token: tokenUsed };
  const limits = { api_call: tenant.plan.api_call_limit, token: tenant.plan.token_limit };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_alerts (tenant_id, period, metric, threshold_pct)
    VALUES (?, ?, ?, ?)
  `);

  const fired = [];
  for (const metric of METRICS) {
    for (const thresholdPct of ALERT_THRESHOLDS) {
      const thresholdQty = Math.ceil((limits[metric] * thresholdPct) / 100);
      if (usage[metric] >= thresholdQty) {
        const info = insert.run(tenant.id, period, metric, thresholdPct);
        if (info.changes > 0) {
          fired.push({
            tenant_id: tenant.id,
            period,
            metric,
            threshold_pct: thresholdPct,
            used: usage[metric],
            limit: limits[metric],
          });
        }
      }
    }
  }
  return fired;
}

/** Alerts recorded for a tenant (primary key excludes duplicates by design). */
function alertsFor(db, tenantId, period) {
  return db
    .prepare(
      'SELECT tenant_id, period, metric, threshold_pct, created_at FROM usage_alerts WHERE tenant_id = ? AND period = ? ORDER BY threshold_pct, metric'
    )
    .all(tenantId, period);
}

module.exports = { evaluateAlerts, alertsFor, ALERT_THRESHOLDS, METRICS };