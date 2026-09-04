const test = require('node:test');
const assert = require('node:assert');
const { makeContext, call, gen, close } = require('./helpers');

// Acceptance #2: quota boundary — request that lands exactly on the limit is
// ALLOWED; the next one is rejected with a clear message.

test('quota boundary: exactly-on-limit allowed, next request 429', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  // Drive t-free to 999/1000 api calls.
  const ins = ctx.db.prepare(
    "INSERT INTO usage_events (tenant_id, type, quantity, idempotency_key) VALUES ('t-free', 'api_call', 1, ?)"
  );
  for (let i = 0; i < 999; i++) ins.run(`seed-call-${i}`);

  // Boundary: current 999 + 1 = 1000 == limit -> ALLOWED (create 201).
  const boundary = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body: gen('boundary-1') });
  assert.equal(boundary.status, 201, 'request landing exactly on the limit is allowed');
  assert.equal(boundary.json.api_calls_used, 1000);

  // Next request: current 1000 + 1 > 1000 -> 429 with clear message.
  const rejected = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body: gen('boundary-2') });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.json.detail.code, 'api_call_quota_exceeded');
  assert.match(rejected.json.detail.message, /exceeds limit 1000/);

  // Nothing was recorded for the rejected request.
  const rows = ctx.db.prepare("SELECT COUNT(*) c FROM usage_events WHERE tenant_id='t-free' AND type='api_call'").get();
  assert.equal(rows.c, 1000);
});

test('quota boundary: token quota exceeded returns 429', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  // Fill token usage to 99,999 / 100,000 (free plan).
  const ins = ctx.db.prepare(
    "INSERT INTO usage_events (tenant_id, type, quantity, idempotency_key) VALUES ('t-free', 'output', ?, ?)"
  );
  ins.run(99999, 'seed-tokens');

  const r = await call(ctx, 'POST', '/generate', {
    headers: { 'X-API-Key': 'key-free' },
    body: gen('tok-1', { max_output_tokens: 100 }), // would push over
  });
  assert.equal(r.status, 429);
  assert.equal(r.json.detail.code, 'token_quota_exceeded');
  assert.match(r.json.detail.message, /AI token quota exceeded/);
});

test('payment gate: Pro tenant without an active subscription -> 402', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  const r = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-pro' }, body: gen('pro-1') });
  assert.equal(r.status, 402);
  assert.equal(r.json.detail.code, 'plan_inactive');
  assert.match(r.json.detail.message, /not active/);

  // And nothing was recorded.
  const c = ctx.db.prepare("SELECT COUNT(*) c FROM usage_events WHERE tenant_id='t-pro'").get();
  assert.equal(c.c, 0);
});

test('payment gate resets after an active subscription lands', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  ctx.db.prepare(
    `INSERT INTO subscriptions (id, tenant_id, plan_id, stripe_subscription_id, stripe_customer_id, status)
     VALUES ('sub-1', 't-pro', 'pro', 'sub_stripe_1', 'cus_1', 'active')`
  ).run();

  const r = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-pro' }, body: gen('pro-2') });
  assert.equal(r.status, 201, 'paid tenant can generate');
});