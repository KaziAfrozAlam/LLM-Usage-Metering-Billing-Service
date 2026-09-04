// Acceptance #3 evidence: Stripe test Checkout -> webhook flips tenant Free -> Pro
// -> GET /usage reflects the new limits.
//
// Simulates a REAL signed Stripe webhook (crypto-verified by our endpoint) for a
// checkout.session.completed event from the demo Test mode checkout.
// Usage: node scripts/demo_checkout_flow.js  (run `npm run seed` + start server first)

const http = require('http');
const dotenv = require('dotenv');
dotenv.config();

const BASE = 'http://localhost:3000';
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, { headers }, (res) => {
      let c = '';
      res.on('data', (d) => (c += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(c) }));
    }).on('error', reject);
  });
}

function postRaw(path, payload, signature) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(payload, 'utf8');
    const req = http.request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'stripe-signature': signature,
      },
    }, (res) => {
      let c = '';
      res.on('data', (d) => (c += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(c) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const Stripe = require('stripe');
  const stripe = new Stripe('sk_test_demo');

  const before = await get('/usage', { 'X-API-Key': 'key_demo_free' });
  console.log('BEFORE checkout (Free plan):');
  console.log(JSON.stringify({ plan: before.body.plan, api_calls: before.body.api_calls, tokens: before.body.tokens }, null, 2));

  // Craft a Stripe-checkout-shaped event (as Stripe would send it in test mode).
  const customerId = 'cus_demo_free_to_pro';
  const subscriptionId = 'sub_demo_free_to_pro';
  const event = {
    id: 'evt_demo_checkout_free_to_pro',
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_demo_free_to_pro',
        object: 'checkout.session',
        mode: 'subscription',
        payment_status: 'paid',
        client_reference_id: 'tenant-free',
        customer: customerId,
        subscription: subscriptionId,
        metadata: { tenant_id: 'tenant-free', plan: 'pro' },
      },
    },
    livemode: false,
    pending_webhooks: 0,
    type: 'checkout.session.completed',
  };
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });

  console.log('\nPOST signed checkout.session.completed webhook ->');
  const webhook = await postRaw('/webhooks/stripe', payload, signature);
  console.log('HTTP', webhook.status, JSON.stringify(webhook.body));

  console.log('\nwaiting for async webhook job to flip the tenant...');
  await sleep(1500);

  const after = await get('/usage', { 'X-API-Key': 'key_demo_free' });
  console.log('AFTER checkout (should be Pro):');
  console.log(JSON.stringify({ plan: after.body.plan, api_calls: after.body.api_calls, tokens: after.body.tokens }, null, 2));

  const db = require('better-sqlite3')(process.env.DATABASE_FILE || 'dev.db');
  console.log('\ntenant row:', JSON.stringify(db.prepare('SELECT id, plan_id, status, stripe_customer_id FROM tenants WHERE id = ?').get('tenant-free')));
  console.log('subscription:', JSON.stringify(db.prepare('SELECT plan_id, status, stripe_subscription_id FROM subscriptions WHERE tenant_id = ?').get('tenant-free')));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});