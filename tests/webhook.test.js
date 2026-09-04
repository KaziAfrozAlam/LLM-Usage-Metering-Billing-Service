const SECRET = 'whsec_test_secret_for_signing';

// Pin the webhook secret BEFORE anything loads config, so the app under test
// verifies signatures with the same secret the tests sign with.
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

const test = require('node:test');
const assert = require('node:assert');
const { makeContext, call, gen, close, sleep } = require('./helpers');

// Acceptance #4: forged webhook (bad signature) -> 400, nothing changes.
// Replay of a real event twice -> processed once.

const Stripe = require('stripe');

function signed(event, secret = SECRET) {
  const stripe = new Stripe('sk_test_demo');
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, signature };
}

function checkoutEvent(id, tenantId, extra = {}) {
  return {
    id,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_${id}`,
        object: 'checkout.session',
        mode: 'subscription',
        payment_status: 'paid',
        client_reference_id: tenantId,
        customer: `cus_${id}`,
        subscription: `sub_${id}`,
        metadata: { tenant_id: tenantId, plan: 'pro' },
      },
    },
    livemode: false,
    pending_webhooks: 0,
    type: 'checkout.session.completed',
  };
}

test('forged webhook: bad signature -> 400 and no state change', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  const res = await call(ctx, 'POST', '/webhooks/stripe', {
    rawBody: JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed' }),
    headers: { 'stripe-signature': 't=1,v1=deadbeefcafe' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'SignatureVerificationFailed');

  const tenant = ctx.db.prepare("SELECT plan_id FROM tenants WHERE id='t-free'").get();
  assert.equal(tenant.plan_id, 'free', 'forged event must not change the tenant');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM stripe_events').get().c, 0);
});

test('valid signed webhook processed once; replay ignored as duplicate', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  // point t-free's webhook secret at our known value
  const event = checkoutEvent('evt_demo_1', 't-free');
  const { payload, signature } = signed(event);

  const first = await call(ctx, 'POST', '/webhooks/stripe', {
    rawBody: payload,
    headers: { 'stripe-signature': signature },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.processed, true);

  await sleep(150);
  assert.equal(ctx.db.prepare("SELECT plan_id FROM tenants WHERE id='t-free'").get().plan_id, 'pro', 'checkout flipped plan');

  // Replay the SAME signed event -> duplicate, no second application.
  const replay = await call(ctx, 'POST', '/webhooks/stripe', {
    rawBody: payload,
    headers: { 'stripe-signature': signature },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.processed, false);
  assert.equal(replay.json.duplicate, true);

  const rows = ctx.db.prepare("SELECT COUNT(*) c FROM stripe_events WHERE id='evt_demo_1'").get();
  assert.equal(rows.c, 1, 'one dedup row');
  const subs = ctx.db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE tenant_id='t-free'").get();
  assert.equal(subs.c, 1, 'subscription applied exactly once');
});

test('webhook updates are applied only for verified, idempotent events', async (t) => {
  const ctx = makeContext();
  t.after(() => close(ctx));

  // checkout flips to pro
  const checkout = checkoutEvent('evt_flip', 't-free');
  const { payload, signature } = signed(checkout);
  await call(ctx, 'POST', '/webhooks/stripe', { rawBody: payload, headers: { 'stripe-signature': signature } });
  await sleep(150);

  const usage = await call(ctx, 'GET', '/usage', { headers: { 'X-API-Key': 'key-free' } });
  assert.equal(usage.json.plan.id, 'pro');
  assert.equal(usage.json.api_calls.limit, 50000, 'GET /usage now shows Pro limits');

  // a DIFFERENT event flips back to free on cancellation
  const cancel = {
    id: 'evt_cancel',
    object: 'event',
    type: 'customer.subscription.deleted',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'sub_cancel', customer: `cus_evt_flip`, status: 'canceled' } },
    livemode: false,
  };
  const c = signed(cancel);
  await call(ctx, 'POST', '/webhooks/stripe', { rawBody: c.payload, headers: { 'stripe-signature': c.signature } });
  await sleep(150);

  const usage2 = await call(ctx, 'GET', '/usage', { headers: { 'X-API-Key': 'key-free' } });
  assert.equal(usage2.json.plan.id, 'free');
});