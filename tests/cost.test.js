const test = require('node:test');
const assert = require('node:assert');
const { makeContext, call, gen, close } = require('./helpers');
const { costMicrosFor, costMicrosForTotals } = require('../src/services/costService');

// Acceptance #5 — pinned pricing produces exact expected totals.
const USD = (micros) => Number(micros) / 1000000;

test('pricing rules: exact totals for fresh/cached/reasoning tokens', () => {
  assert.equal(costMicrosFor('input', 1000000), 3000000n); // $3.00/1M
  assert.equal(costMicrosFor('cached_input', 1000000), 300000n); // $0.30/1M -> cheaper
  assert.equal(costMicrosFor('output', 1000000), 15000000n); // $15.00/1M
  assert.equal(costMicrosFor('reasoning', 1000000), 15000000n); // billed as output

  // Rule C: per-category rates; NOT a naive single-rate sum.
  const perCategory = costMicrosFor('input', 1000000) + costMicrosFor('cached_input', 1000000);
  const naive = costMicrosFor('input', 2000000);
  assert.equal(perCategory, 3300000n);
  assert.notEqual(perCategory, naive);
});

const Stripe = require('stripe');

test('usage route: GET /usage matches per-category totals', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  // Paid tenant: activate the Pro subscription first.
  ctx.db.prepare(
    `INSERT INTO subscriptions (id, tenant_id, plan_id, stripe_subscription_id, stripe_customer_id, status)
     VALUES ('sub-cost', 't-pro', 'pro', 'sub_cost_1', 'cus_cost_1', 'active')`
  ).run();

  const r = await call(ctx, 'POST', '/generate', {
    headers: { 'X-API-Key': 'key-pro' },
    body: gen('cost-1', { prompt: 'cache-aware billing design with reasoning about determinism', max_output_tokens: 1000, reasoning_tokens: 200, cache_input: true }),
  });
  assert.equal(r.status, 201);
  const expectedMicros =
    costMicrosFor('cached_input', r.json.prompt_tokens) + costMicrosFor('output', 1000) + costMicrosFor('reasoning', 200);

  const usage = await call(ctx, 'GET', '/usage', { headers: { 'X-API-Key': 'key-pro' } });
  assert.equal(usage.status, 200);

  // request-level cost === api-level rollup cost for the same period (single request)
  assert.equal(Number(expectedMicros), usage.json.cost.micro_units);
  assert.equal(usage.json.breakdown.reasoning.billed_as, 'output');
  assert.equal(usage.json.breakdown.cached_input.used, r.json.prompt_tokens);
  assert.equal(usage.json.breakdown.output.used, 1000);
  assert.equal(usage.json.breakdown.reasoning.used, 200);

  // Sanity: naive sum would NOT match.
  const naive = costMicrosFor('output', 1000) + costMicrosFor('input', r.json.prompt_tokens + 200);
  assert.notEqual(Number(naive), usage.json.cost.micro_units);
});

test('money is integers: cost API reports integer cents/micro-units', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  const r = await call(ctx, 'GET', '/usage', { headers: { 'X-API-Key': 'key-free' } });
  assert.equal(Number.isInteger(r.json.cost.micro_units), true);
  assert.equal(Number.isInteger(r.json.cost.cents), true);
});