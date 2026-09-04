// Stripe (test mode only) integration helpers + subscription state sync.
// Never touches live mode: all calls go through the test API key.

const config = require('../config');

function assertStripeConfigured() {
  if (!config.stripe.secretKey) {
    const err = new Error('STRIPE_SECRET_KEY is not configured');
    err.status = 500;
    throw err;
  }
}

function stripe() {
  assertStripeConfigured();
  const Stripe = require('stripe');
  return new Stripe(config.stripe.secretKey, { apiVersion: config.stripe.apiVersion });
}

/**
 * Lazily resolves a Stripe Customer for a tenant.
 * @returns {Promise<{customerId: string}>}
 */
async function ensureCustomer(db, tenant) {
  if (tenant.stripe_customer_id) return { customerId: tenant.stripe_customer_id };
  const s = stripe();
  const customer = await s.customers.create({
    name: tenant.name,
    metadata: { tenant_id: tenant.id, auto: 'usage-metering-demo' },
  });
  db.prepare(
    `UPDATE tenants
        SET stripe_customer_id = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`
  ).run(customer.id, tenant.id);
  tenant.stripe_customer_id = customer.id;
  return { customerId: customer.id };
}

/**
 * Creates a Stripe Checkout Session (mode=subscription) for a plan.
 * Returns { session, customerId }.
 */
async function createCheckoutSession(db, tenant, plan, opts = {}) {
  const { customerId } = await ensureCustomer(db, tenant);
  const priceId = plan.stripe.price_id;
  if (!priceId) {
    const err = new Error(`No Stripe price configured for plan "${plan.id}". Run \`npm run seed\` with STRIPE_SECRET_KEY set to create one.`);
    err.status = 500;
    throw err;
  }
  const s = stripe();
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: tenant.id,
    metadata: { tenant_id: tenant.id, plan: plan.id },
    success_url: opts.success_url || 'http://localhost:3000/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: opts.cancel_url || 'http://localhost:3000/checkout/cancel',
    allow_promotion_codes: true,
  });
  return { session, customerId };
}

/** Extracts the line item price id from a Checkout session. */
function priceIdOf(session) {
  const line = session.metadata && session.metadata.price_id;
  if (line) return line;
  if (session.line_items && session.line_items.data && session.line_items.data[0]) {
    return session.line_items.data[0].price.id;
  }
  return null;
}

/** Map Stripe subscription status -> our normalized status. */
const SUB_STATUS_MAP = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  paused: 'past_due',
};

function normalizeStatus(status) {
  return SUB_STATUS_MAP[status] || 'incomplete';
}

module.exports = {
  stripe,
  ensureCustomer,
  createCheckoutSession,
  priceIdOf,
  normalizeStatus,
  assertStripeConfigured,
};