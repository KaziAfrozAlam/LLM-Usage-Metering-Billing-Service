// Subscription state sync — the ONLY place tenant plan/status changes happen
// from Stripe events. Runs inside the async webhook job (with retry).

const { getPlan, getTenant } = require('./repo');
const { normalizeStatus } = require('./stripeService');

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function timestampOrNull(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString();
}

function upsertSubscription(db, { tenantId, planId, stripeSubscriptionId, customerId, status, periodStartTs, periodEndTs }) {
  const existing = stripeSubscriptionId
    ? db.prepare('SELECT id FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubscriptionId)
    : null;

  const fields = {
    tenant_id: tenantId,
    plan_id: planId,
    stripe_subscription_id: stripeSubscriptionId || null,
    stripe_customer_id: customerId || null,
    status,
    current_period_start: timestampOrNull(periodStartTs),
    current_period_end: timestampOrNull(periodEndTs),
  };

  if (existing) {
    db.prepare(
      `UPDATE subscriptions
          SET plan_id = ?, status = ?, stripe_customer_id = ?,
              current_period_start = ?, current_period_end = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`
    ).run(fields.plan_id, fields.status, fields.stripe_customer_id || null, fields.current_period_start, fields.current_period_end, existing.id);
    return existing.id;
  }

  const id = newId('sub');
  db.prepare(
    `INSERT INTO subscriptions (id, tenant_id, plan_id, stripe_subscription_id, stripe_customer_id, status, current_period_start, current_period_end)
     VALUES (@id, @tenant_id, @plan_id, @stripe_subscription_id, @stripe_customer_id, @status, @current_period_start, @current_period_end)`
  ).run({ id, ...fields });
  return id;
}

/** Resolve the plan id from Stripe data (price metadata, or session metadata). */
function planIdFromStripe(data) {
  if (data && data.metadata && (data.metadata.plan === 'pro' || data.metadata.plan === 'free')) {
    return data.metadata.plan;
  }
  if (data && data.items && data.items.data && data.items.data[0] && data.items.data[0].price) {
    const price = data.items.data[0].price;
    if (price.metadata && (price.metadata.plan === 'free' || price.metadata.plan === 'pro')) return price.metadata.plan;
  }
  return 'pro';
}

/**
 * checkout.session.completed — a tenant subscribed (or re-subscribed).
 * Only sessions with mode=subscription and a completed payment status apply.
 */
function applyCheckoutCompleted(db, event) {
  const session = event.data.object;
  if (session.mode === 'subscription' && !['paid', 'no_payment_required'].includes(session.payment_status)) {
    return { applied: false, reason: `payment_status=${session.payment_status}` };
  }
  const tenantId = (session.client_reference_id) || (session.metadata && session.metadata.tenant_id);
  const tenant = tenantId ? getTenant(db, tenantId) : null;
  if (!tenant) {
    throw new Error(`No tenant for client_reference_id "${tenantId}"`);
  }
  const planId = planIdFromStripe(session) || 'pro';
  const plan = getPlan(db, planId);
  if (!plan) throw new Error(`Unknown plan "${planId}"`);

  const subId = session.subscription || session.id;
  const customerId = session.customer;

  const subscriptionId = upsertSubscription(db, {
    tenantId: tenant.id,
    planId,
    stripeSubscriptionId: typeof subId === 'string' ? subId : null,
    customerId,
    status: 'active',
  });

  db.prepare(
    `UPDATE tenants
        SET plan_id = ?, status = 'active',
            stripe_customer_id = COALESCE(stripe_customer_id, ?),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`
  ).run(planId, customerId, tenant.id);

  return { applied: true, tenant_id: tenant.id, plan_id: planId, subscription_id: subscriptionId, stripe_subscription_id: subId };
}

/** customer.subscription.updated — sync status + period + plan from Stripe. */
function applySubscriptionUpdated(db, event) {
  const sub = event.data.object;
  const customerId = sub.customer;
  const tenant = customerId ? getTenantByCustomer(db, customerId) : null;
  if (!tenant) {
    // Could not map customer -> tenant: still record the subscription row for tracking.
    throw new Error(`No tenant for Stripe customer "${customerId}"`);
  }
  const planId = planIdFromStripe(sub) || 'pro';
  const status = normalizeStatus(sub.status);

  upsertSubscription(db, {
    tenantId: tenant.id,
    planId,
    stripeSubscriptionId: sub.id,
    customerId,
    status,
    periodStartTs: sub.current_period_start,
    periodEndTs: sub.current_period_end,
  });

  // A non-active subscription terminates paid entitlements (plan gates on 402).
  const tenantPlanId = status === 'canceled' || status === 'past_due' || status === 'incomplete'
    ? 'free'
    : planId;
  const tenantStatus = status === 'canceled' ? 'active' : tenant.status;

  db.prepare(
    `UPDATE tenants
        SET plan_id = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`
  ).run(tenantPlanId, tenantStatus, tenant.id);

  return { applied: true, tenant_id: tenant.id, plan_id: tenantPlanId, subscription_status: status };
}

function getTenantByCustomer(db, customerId) {
  return db.prepare('SELECT * FROM tenants WHERE stripe_customer_id = ?').get(customerId) || null;
}

/** customer.subscription.deleted — cancel -> downgrade to Free. */
function applySubscriptionDeleted(db, event) {
  const sub = event.data.object;
  const customerId = sub.customer;
  const tenant = customerId ? getTenantByCustomer(db, customerId) : null;
  if (!tenant) return { applied: false, reason: 'tenant_not_found' };

  const status = 'canceled';
  upsertSubscription(db, {
    tenantId: tenant.id,
    planId: 'free',
    stripeSubscriptionId: sub.id,
    customerId,
    status,
  });

  db.prepare(
    `UPDATE tenants
        SET plan_id = 'free', status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`
  ).run(tenant.id);

  return { applied: true, tenant_id: tenant.id, plan_id: 'free' };
}

module.exports = {
  applyCheckoutCompleted,
  applySubscriptionUpdated,
  applySubscriptionDeleted,
  upsertSubscription,
  planIdFromStripe,
};