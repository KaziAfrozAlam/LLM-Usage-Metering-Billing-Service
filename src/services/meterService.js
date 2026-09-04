// Idempotent usage metering.
//
// Design: the caller passes an idempotency key for a logical unit of work
// (a billable request). The meter derives a per-type sub-key and stores each
// usage event with a UNIQUE idempotency_key. Re-sending the same key cannot
// insert a second row (ON CONFLICT DO NOTHING) — the original row is returned.

const TOKEN_TYPES = ['input', 'cached_input', 'output', 'reasoning'];

class UsageConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageConflictError';
    this.status = 409;
  }
}

/**
 * Records one usage event idempotently.
 * @param {Database} db better-sqlite3
 * @param {string} tenantId
 * @param {'api_call'|'input'|'cached_input'|'output'|'reasoning'} type
 * @param {number} qty non-negative integer
 * @param {string} idempotencyKey globally unique per usage event
 * @returns {{ recorded: boolean, event: object }}
 */
function record(db, tenantId, type, qty, idempotencyKey) {
  if (!['api_call', ...TOKEN_TYPES].includes(type)) {
    throw new UsageConflictError(`Unknown usage type: ${type}`);
  }
  if (!Number.isInteger(qty) || qty < 0) {
    throw new UsageConflictError('quantity must be a non-negative integer');
  }

  const existing = db
    .prepare('SELECT tenant_id, type, quantity, idempotency_key, recorded_at FROM usage_events WHERE idempotency_key = ?')
    .get(idempotencyKey);

  if (existing) {
    return { recorded: false, event: existing };
  }

  const info = db
    .prepare('INSERT INTO usage_events (tenant_id, type, quantity, idempotency_key) VALUES (?, ?, ?, ?)')
    .run(tenantId, type, qty, idempotencyKey);

  const event = db
    .prepare('SELECT tenant_id, type, quantity, idempotency_key, recorded_at FROM usage_events WHERE id = ?')
    .get(info.lastInsertRowid);

  return { recorded: true, event };
}

/**
 * Records a multi-typed billable request idempotently. If ANY of the
 * sub-keys already exists the request is treated as a duplicate and nothing
 * new is recorded.
 * @returns {{ isDuplicate: boolean, events: object[] }}
 */
function recordRequest(db, tenantId, usageByType, requestKey) {
  const allExisting = [];
  for (const [type, qty] of Object.entries(usageByType)) {
    const subKey = `${requestKey}::${type}`;
    const res = record(db, tenantId, type, qty, subKey);
    allExisting.push(res);
  }

  const isDuplicate = allExisting.some((r) => !r.recorded);
  const events = allExisting.map((r) => r.event);
  return { isDuplicate, events };
}

/** Period helpers (UTC calendar month). */
function periodOf(isoTimestamp) {
  return (isoTimestamp || new Date().toISOString()).slice(0, 7); // 'YYYY-MM'
}

function periodStart(period) {
  return `${period}-01T00:00:00.000Z`;
}

function periodEndExclusive(period) {
  const [y, m] = period.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1 + 1, 1));
  return next.toISOString();
}

/** Total quantity recorded for a tenant in a period, grouped by type. */
function totalsByType(db, tenantId, period) {
  const rows = db
    .prepare(
      `SELECT type, COALESCE(SUM(quantity), 0) AS qty
         FROM usage_events
        WHERE tenant_id = ? AND recorded_at >= ? AND recorded_at < ?
        GROUP BY type`
    )
    .all(tenantId, periodStart(period), periodEndExclusive(period));
  const totals = { api_call: 0, input: 0, cached_input: 0, output: 0, reasoning: 0 };
  for (const r of rows) totals[r.type] = r.qty;
  return totals;
}

/**
 * Plain monthly usage (used + remaining) for a tenant in a period.
 * @returns {{ period, api_calls: {used, limit, remaining}, tokens: {used, limit, remaining} }}
 */
function usageSnapshot(db, tenantId, period, plan) {
  const totals = totalsByType(db, tenantId, period);
  const tokenUsed = totals.input + totals.cached_input + totals.output + totals.reasoning;

  return {
    period,
    api_calls: {
      used: totals.api_call,
      limit: plan.api_call_limit,
      remaining: Math.max(0, plan.api_call_limit - totals.api_call),
    },
    tokens: {
      used: tokenUsed,
      limit: plan.token_limit,
      remaining: Math.max(0, plan.token_limit - tokenUsed),
    },
  };
}

module.exports = {
  record,
  recordRequest,
  totalsByType,
  usageSnapshot,
  periodOf,
  periodStart,
  periodEndExclusive,
  TOKEN_TYPES,
  UsageConflictError,
};