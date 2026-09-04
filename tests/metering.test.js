const test = require('node:test');
const assert = require('node:assert');
const { makeContext, call, gen, close } = require('./helpers');

// Acceptance #1: same billable request with one idempotency key twice
// -> exactly one usage event (per type), second response mirrors the first.
test('idempotent metering: duplicate key stores exactly one usage event', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  const body = gen('dup-001', { max_output_tokens: 25 });

  const first = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body });
  assert.equal(first.status, 201);
  assert.equal(first.json.duplicate, false);

  const second = await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body });
  assert.equal(second.status, 201);
  assert.equal(second.json.duplicate, true);

  const events = ctx.db
    .prepare("SELECT type, quantity FROM usage_events WHERE tenant_id = 't-free' AND idempotency_key LIKE 'dup-001::%'")
    .all();
  const byType = events.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
  assert.equal(byType.api_call, 1, 'exactly one api_call event');
  assert.equal(byType.input, 1, 'exactly one input event');
  assert.equal(byType.output, 1, 'exactly one output event');

  assert.deepEqual(second.json.prompt_tokens, first.json.prompt_tokens);
  assert.deepEqual(second.json.output_tokens, first.json.output_tokens);
  assert.deepEqual(second.json.cost_micros, first.json.cost_micros, 'duplicate mirrors original cost');
});

test('idempotent metering: request_responses has one row; usage unchanged on duplicate', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  const before = await call(ctx, 'GET', '/usage', { headers: { 'X-API-Key': 'key-free' } });
  await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body: gen('dup-002') });
  await call(ctx, 'POST', '/generate', { headers: { 'X-API-Key': 'key-free' }, body: gen('dup-002') });
  const after = await call(ctx, 'GET', '/usage', { headers: { 'X-API-Key': 'key-free' } });

  assert.equal(after.json.api_calls.used - before.json.api_calls.used, 1, 'exactly one api call counted');
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) c FROM request_responses WHERE idempotency_key = 'dup-002'").get().c,
    1
  );
});