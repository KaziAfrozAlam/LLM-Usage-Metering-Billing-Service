// Data-access helpers. All tenant queries are scoped to a tenant id (isolation).

const { periodOf } = require('./meterService');

function getPlan(db, planId) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) || null;
}

function getTenant(db, tenantId) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) || null;
}

function getTenantByApiKey(db, apiKey) {
  return db.prepare('SELECT * FROM tenants WHERE api_key = ?').get(apiKey) || null;
}

function getTenantByStripeCustomer(db, customerId) {
  return db.prepare('SELECT * FROM tenants WHERE stripe_customer_id = ?').get(customerId) || null;
}

/**
 * Loads a tenant together with `plan` and `subscription_status`:
 * - Subscriptions that exist but are not active set a non-active status.
 * - Free plan tenants with no subscription never fail the payment gate.
 */
function loadTenantWithPlan(db, tenantId) {
  const tenant = getTenant(db, tenantId);
  if (!tenant) return null;
  const plan = getPlan(db, tenant.plan_id);
  const sub = db
    .prepare(
      `SELECT * FROM subscriptions
        WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(tenantId);

  return {
    id: tenant.id,
    name: tenant.name,
    api_key: tenant.api_key,
    status: tenant.status,
    stripe_customer_id: tenant.stripe_customer_id,
    plan,
    subscription_status: sub ? sub.status : null,
    subscription: sub,
  };
}

const MONTHLY_PERIOD = () => periodOf(new Date().toISOString());

module.exports = {
  getPlan,
  getTenant,
  getTenantByApiKey,
  getTenantByStripeCustomer,
  loadTenantWithPlan,
  MONTHLY_PERIOD,
};