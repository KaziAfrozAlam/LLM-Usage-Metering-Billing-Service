// Monthly rollup background job with retry/failure handling.
// Recomputes usage_rollups rows for every tenant for a target period and logs
// cost. Safe to run repeatedly (upsert). Can be scheduled (server interval)
// or run manually via `npm run rollup`.

const { periodStart, periodEndExclusive } = require('../services/meterService');
const { costMicrosForTotals } = require('../services/costService');
const { evaluateAlerts } = require('../services/alertService');

function persistRollups(db, period) {
  const rows = db
    .prepare(
      `SELECT tenant_id,
              SUM(CASE WHEN type = 'api_call' THEN quantity ELSE 0 END) AS api_calls,
              SUM(CASE WHEN type = 'input' THEN quantity ELSE 0 END) AS input_tokens,
              SUM(CASE WHEN type = 'cached_input' THEN quantity ELSE 0 END) AS cached_input_tokens,
              SUM(CASE WHEN type = 'output' THEN quantity ELSE 0 END) AS output_tokens,
              SUM(CASE WHEN type = 'reasoning' THEN quantity ELSE 0 END) AS reasoning_tokens
         FROM usage_events
        WHERE recorded_at >= ? AND recorded_at < ?
        GROUP BY tenant_id`
    )
    .all(periodStart(period), periodEndExclusive(period));

  const upsert = db.prepare(
    `INSERT INTO usage_rollups
       (tenant_id, period, api_calls, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, cost_micros)
     VALUES (@tenant_id, @period, @api_calls, @input_tokens, @cached_input_tokens, @output_tokens, @reasoning_tokens, @cost_micros)
     ON CONFLICT (tenant_id, period) DO UPDATE SET
       api_calls = excluded.api_calls,
       input_tokens = excluded.input_tokens,
       cached_input_tokens = excluded.cached_input_tokens,
       output_tokens = excluded.output_tokens,
       reasoning_tokens = excluded.reasoning_tokens,
       cost_micros = excluded.cost_micros,
       computed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  );

  const result = [];
  for (const row of rows) {
    const totals = {
      input: row.input_tokens,
      cached_input: row.cached_input_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
    };
    const costMicros = costMicrosForTotals(totals);
    upsert.run({ ...row, cost_micros: costMicros, period });
    result.push({
      tenant_id: row.tenant_id,
      period,
      api_calls: row.api_calls,
      tokens: row.input_tokens + row.cached_input_tokens + row.output_tokens + row.reasoning_tokens,
      cost_micros: costMicros,
    });
  }
  return result;
}

/** Alerts side-effect for all tenants present in a period (rollup companion). */
function evaluateAlertsForPeriod(db, period) {
  const { loadTenantWithPlan } = require('../services/repo');
  const tenantIds = db.prepare('SELECT DISTINCT tenant_id FROM usage_events').all().map((r) => r.tenant_id);
  const fired = [];
  for (const tenantId of tenantIds) {
    const tenant = loadTenantWithPlan(db, tenantId);
    if (!tenant) continue;
    try {
      fired.push(...evaluateAlerts(db, tenant, period));
    } catch (err) {
      console.error(`[alerts] evaluation failed for ${tenantId}:`, err.message);
    }
  }
  for (const a of fired) {
    console.log(`[alerts] ${a.tenant_id} | ${a.period} | ${a.metric} at ${a.threshold_pct}% (used ${a.used}/${a.limit})`);
  }
  return fired;
}

/** Handler for the queue / scheduler. Returns per-tenant rollup lines. */
function runRollup(db, period = new Date().toISOString().slice(0, 7)) {
  const persisted = persistRollups(db, period);
  console.log(`[rollup] period ${period}: rolled up ${persisted.length} tenant(s)`);
  for (const r of persisted) {
    console.log(
      `[rollup] ${r.tenant_id} | ${r.period} | api_calls=${r.api_calls} tokens=${r.tokens} cost_micros=${r.cost_micros}`
    );
  }
  evaluateAlertsForPeriod(db, period);
  return persisted;
}

module.exports = { runRollup, persistRollups, evaluateAlertsForPeriod };

if (require.main === module) {
  const { createDb, applyMigrations } = require('../db');
  const db = createDb();
  applyMigrations(db);
  try {
    runRollup(db, process.argv[2]);
  } finally {
    db.close();
  }
}