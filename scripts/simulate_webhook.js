// Test-mode webhook simulation — proves signature verification + dedup
// WITHOUT needing the Stripe CLI or a public tunnel.
//
// Uses Stripe's own cryptographic signing (stripe.webhooks.constructEvent /
// generateTestHeaderString) with the local webhook secret, then posts the
// raw body to /webhooks/stripe.
//
// Scenarios:
//   1. forged (unsigned / wrong signature) -> 400, nothing changes
//   2. valid checkout.session.completed     -> 200 processed once
//   3. replay of the SAME event             -> 200 duplicate:true, ignored
//
// Usage: node scripts/simulate_webhook.js

const http = require('http');
const dotenv = require('dotenv');
dotenv.config();

const BASE = 'http://localhost:3000';
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function post(path, body, signature) {
  return new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(body)
      ? body
      : typeof body === 'string'
        ? Buffer.from(body, 'utf8') // raw signed payload must be sent byte-for-byte
        : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...(signature ? { 'stripe-signature': signature } : {}),
      },
    }, (res) => {
      let chunk = '';
      res.on('data', (d) => (chunk += d));
      res.on('end', () => resolve({ status: res.statusCode, body: chunk }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function signedEvent(event, secret) {
  const Stripe = require('stripe');
  const stripe = new Stripe('sk_test_demo');
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

function newEvent(type, id, data) {
  return {
    id,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    data: { object: data },
    livemode: false,
    pending_webhooks: 0,
    request: { id: `req_${id}` },
    type,
  };
}

async function main() {
  if (!SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET must be set (run `stripe listen` and copy the whsec_ value).');
    process.exit(1);
  }

  // Shared fake subscription for the session + subscription events.
  const subId = 'sub_demo_123';
  const customerId = 'cus_demo_123';
  const fakeSub = {
    id: subId,
    object: 'subscription',
    status: 'active',
    customer: customerId,
    current_period_start: Math.floor(Date.now() / 1000) - 86400,
    current_period_end: Math.floor(Date.now() / 1000) + 29 * 86400,
    items: {
      object: 'list',
      data: [{ price: { id: 'price_pro_demo', currency: 'usd', metadata: { plan: 'pro' } } }],
    },
  };

  console.log('== 1) FORGED WEBHOOK (garbled signature) -> expect 400 ==');
  const forged = await post('/webhooks/stripe', { id: 'evt_forged', type: 'checkout.session.completed' }, 't=1,v1=deadbeef');
  console.log(`HTTP ${forged.status} body: ${forged.body}`);

  console.log('\n== 2) VALID checkout.session.completed (tenant-free -> pro) ==');
  const checkoutEvent = newEvent('checkout.session.completed', 'evt_demo_checkout', {
    id: 'cs_demo_123',
    object: 'checkout.session',
    mode: 'subscription',
    payment_status: 'paid',
    client_reference_id: 'tenant-free',
    customer: customerId,
    subscription: subId,
    metadata: { tenant_id: 'tenant-free', plan: 'pro' },
    line_items: { data: [{ price: { id: 'price_pro_demo', metadata: { plan: 'pro' } } }] },
  });
  const s1 = signedEvent(checkoutEvent, SECRET);
  const r1 = await post('/webhooks/stripe', s1.payload, s1.header);
  console.log(`HTTP ${r1.status} body: ${r1.body}`);

  console.log('\n== 3) REPLAY of the SAME event id -> expect duplicate, processed once ==');
  const r2 = await post('/webhooks/stripe', s1.payload, s1.header);
  console.log(`HTTP ${r2.status} body: ${r2.body}`);

  console.log('\n== 4) VALID customer.subscription.updated (canceled -> downgrade tenant-free to free) ==');
  const subUpdated = newEvent('customer.subscription.updated', 'evt_demo_sub_updated', { ...fakeSub, status: 'canceled' });
  const s2 = signedEvent(subUpdated, SECRET);
  const r3 = await post('/webhooks/stripe', s2.payload, s2.header);
  console.log(`HTTP ${r3.status} body: ${r3.body}`);

  console.log('\n== after webhooks =================================================');
  const check = await new Promise((resolve, reject) => {
    const req = http.get(`${BASE}/plans`, (res) => {
      let c = '';
      res.on('data', (d) => (c += d));
      res.on('end', () => resolve(c));
    });
    req.on('error', reject);
  });
  console.log('plans (unchanged):', check);

  const stripeEvents = require('better-sqlite3')(process.env.DATABASE_FILE || 'dev.db')
    .prepare('SELECT id, type FROM stripe_events ORDER BY created_at').all();
  console.log('stripe_events rows:', JSON.stringify(stripeEvents));

  const db = require('better-sqlite3')(process.env.DATABASE_FILE || 'dev.db');
  for (const id of ['tenant-free']) {
    const t = db.prepare('SELECT id, plan_id, status FROM tenants WHERE id = ?').get(id);
    const subs = db.prepare('SELECT id, plan_id, status, stripe_subscription_id FROM subscriptions WHERE tenant_id = ?').all(id);
    console.log(`tenant ${id}:`, JSON.stringify(t), 'subscriptions:', JSON.stringify(subs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});