// Drives a tenant to N usage events for alert demos.
// Usage: node scripts/plant_usage.js <tenant> <type> <count> [prefix]
const db = require('better-sqlite3')('dev.db');
const tenant = process.argv[2] || 'tenant-free';
const type = process.argv[3] || 'api_call';
const count = Number(process.argv[4] || 800);
const prefix = process.argv[5] || 'plant';

const ins = db.prepare(
  "INSERT INTO usage_events (tenant_id, type, quantity, idempotency_key) VALUES (?, ?, 1, ?)"
);
const tx = db.transaction(() => {
  for (let i = 0; i < count; i++) ins.run(tenant, type, `${prefix}-${i}`);
});
tx();

const total = db
  .prepare('SELECT COALESCE(SUM(quantity),0) q FROM usage_events WHERE tenant_id = ? AND type = ?')
  .get(tenant, type).q;
console.log(`planted ${count} x '${type}' for ${tenant} (total now ${total})`);