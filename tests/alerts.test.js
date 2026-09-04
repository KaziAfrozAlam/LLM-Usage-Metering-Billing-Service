const test = require('node:test');
const assert = require('node:assert');
const { makeContext, call, gen, close } = require('./helpers');

// Stretch goal — usage alerts at 80% and 100% of limit, once per threshold/period.

test('alerts fire at 80% then 100%, exactly once each', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  // Free tenant: API-call limit 1000 -> 80% at 800, 100% at 1000.
  const ins = ctx.db.prepare(
    "INSERT INTO usage_events (tenant_id, type, quantity, idempotency_key) VALUES ('t-free', 'api_call', 1, ?)"
  );

  for (let i = 0; i < 800; i++) ins.run(`a-${i}`); // exactly 80%

  const r = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body: gen('a-gen-1') });
  assert.equal(r.status, 201);
  const fired80 = r.json.alerts.find((x) => x.threshold_pct === 80 && x.metric === 'api_call');
  assert.ok(fired80, '80% api_call alert fired on the request that crossed it');
  assert.equal(r.json.alerts.filter((x) => x.threshold_pct === 100).length, 0, '100% not yet fired');

  // Drive to 999 (one below limit) then one allowed request lands exactly on 1000.
  for (let i = 800; i < 998; i++) ins.run(`a-${i}`); // used = 999
  const r2 = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body: gen('a-gen-2') }); // lands exactly on 1000
  assert.equal(r2.status, 201);
  const fired100 = r2.json.alerts.find((x) => x.threshold_pct === 100 && x.metric === 'api_call');
  assert.ok(fired100, '100% api_call alert fired on the request that hit the limit');
  const r3 = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body: gen('a-gen-3') }); // > limit -> 429, no recording
  assert.equal(r3.status, 429);

  const alerts = await call(ctx, 'GET', '/usage/alerts', { headers: { 'X-API-Key': 'key-free' } });
  const apiAlerts = alerts.json.alerts.filter((a) => a.metric === 'api_call');
  assert.deepEqual(
    apiAlerts.map((a) => a.threshold_pct).sort((a, b) => a - b),
    [80, 100],
    'both thresholds recorded'
  );

  // One more request would NOT add duplicates (UNIQUE constraint).
  const ins2 = ctx.db.prepare("INSERT INTO usage_events (tenant_id, type, quantity, idempotency_key) VALUES ('t-free','output',1,'a-extra')");
  ins2.run();

  const alertsAgain = await call(ctx, 'GET', '/usage/alerts', { headers: { 'X-API-Key': 'key-free' } });
  const apiAlertsAgain = alertsAgain.json.alerts.filter((a) => a.metric === 'api_call');
  assert.equal(apiAlertsAgain.length, 2, 'alerts are deduplicated (no re-fire)');
});

test('token 80% alert fires; retrieval is tenant-scoped', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  // t-free: token limit 100,000 -> 80,000 is 80%.
  ctx.db
    .prepare("INSERT INTO usage_events (tenant_id, type, quantity, idempotency_key) VALUES ('t-free','output',80000,'a-tok')")
    .run();

  const r = await call(ctx, 'GET', '/usage/alerts?period=2026-09', { headers: { 'X-API-Key': 'key-free' } });
  assert.equal(r.status, 200, 'alerts endpoint returns 200');

  // Alerts are evaluated during generate; run one to trigger the token alert.
  await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body: gen('a-tok-gen') });

  const alerts = await call(ctx, 'GET', '/usage/alerts', { headers: { 'X-API-Key': 'key-free' } });
  assert.ok(alerts.json.alerts.some((a) => a.metric === 'token' && a.threshold_pct === 80));

  // Different tenant sees empty (isolation).
  const other = await call(ctx, 'GET', '/usage/alerts', { headers: { 'X-API-Key': 'key-pro' } });
  assert.deepEqual(other.json.alerts, []);
});