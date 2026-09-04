const config = require('../config');
const { createDb, applyMigrations } = require('./index');

async function ensureStripePlanResources() {
  if (!config.stripe.secretKey) {
    console.log('[seed] STRIPE_SECRET_KEY not set - skipping Stripe resource creation (use existing STRIPE_PRICE_PRO or run `stripe` dashboard manually).');
    return null;
  }
  if (config.PLANS.pro.stripe.price_id) {
    console.log(`[seed] Using existing STRIPE_PRICE_PRO = ${config.PLANS.pro.stripe.price_id}`);
    return config.PLANS.pro.stripe.price_id;
  }
  const Stripe = require('stripe');
  const stripe = new Stripe(config.stripe.secretKey);
  const product = await stripe.products.create({ name: 'Pro plan (Usage Metering)' });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: config.PLANS.pro.price_cents,
    currency: 'usd',
    recurring: { interval: 'month' },
    metadata: { plan: 'pro' },
  });
  config.PLANS.pro.stripe.price_id = price.id;
  console.log(`[seed] Created Stripe product ${product.id} / price ${price.id} (test mode, $${(price.unit_amount / 100).toFixed(2)}/mo)`);
  return price.id;
}

async function seed() {
  const db = createDb();
  applyMigrations(db);

  const upsertPlan = db.prepare(`
    INSERT INTO plans (id, name, api_call_limit, token_limit, price_cents)
    VALUES (@id, @name, @api_call_limit, @token_limit, @price_cents)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      api_call_limit = excluded.api_call_limit,
      token_limit = excluded.token_limit,
      price_cents = excluded.price_cents
  `);

  upsertPlan.run(config.PLANS.free);
  upsertPlan.run(config.PLANS.pro);
  console.log('[seed] plans: free + pro');

  const tenants = [
    { id: 'tenant-free', name: 'Free Demo Tenant', apiKey: 'key_demo_free', plan: 'free' },
    { id: 'tenant-pro', name: 'Pro Demo Tenant', apiKey: 'key_demo_pro', plan: 'pro' },
  ];

  const upsertTenant = db.prepare(`
    INSERT INTO tenants (id, name, api_key, plan_id, status)
    VALUES (@id, @name, @apiKey, @plan, 'active')
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      api_key = excluded.api_key,
      plan_id = excluded.plan_id,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `);

  for (const t of tenants) upsertTenant.run(t);

  console.log('[seed] tenants:');
  for (const t of tenants) {
    console.log(`  ${t.id}  (plan: ${t.plan})  api_key=${t.apiKey}`);
  }

  const priceId = await ensureStripePlanResources();
  if (priceId) console.log(`[seed] Pro Stripe price: ${priceId}`);

  db.close();
  console.log('[seed] done');
}

seed().catch((err) => {
  console.error('[seed] failed:', err.message);
  process.exit(1);
});