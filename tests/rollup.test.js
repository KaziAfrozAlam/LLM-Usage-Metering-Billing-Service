const test = require('node:test');
const assert = require('node:assert');
const { makeContext, close } = require('./helpers');
const { persistRollups } = require('../src/jobs/rollup');

test('rollup job produces correct monthly totals and cost', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  const ins = ctx.db.prepare(
    "INSERT INTO usage_events (tenant_id, type, quantity, idempotency_key) VALUES ('t-free', ?, ?, ?)"
  );
  ins.run('api_call', 5, 'r-api-1');
  ins.run('api_call', 3, 'r-api-2');
  ins.run('input', 1000000, 'r-in');
  ins.run('cached_input', 1000000, 'r-cached');
  ins.run('reasoning', 500000, 'r-reason');

  const rows = persistRollups(ctx.db, '2026-09');
  const row = rows.find((r) => r.tenant_id === 't-free');
  assert.ok(row);
  assert.equal(row.api_calls, 8);
  assert.equal(row.tokens, 2500000);
  // 1M input (3300000 micros? no: input 1M=$3 + cached 1M=$0.30 + reasoning .5M@$15/1M=$7.50)
  // 3,000,000 + 300,000 + 7,500,000 = 10,800,000 micros
  assert.equal(row.cost_micros, 10800000n);
});

test('rollup is idempotent (upsert, safe to re-run)', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  const ins = ctx.db.prepare("INSERT INTO usage_events (tenant_id, type, quantity, idempotency_key) VALUES ('t-free', 'output', 100, 'r-o')");
  ins.run();

  persistRollups(ctx.db, '2026-09');
  persistRollups(ctx.db, '2026-09');
  const rows = ctx.db.prepare("SELECT COUNT(*) c FROM usage_rollups WHERE tenant_id='t-free' AND period='2026-09'").get();
  assert.equal(rows.c, 1);
});