// Quota enforcement.
//
// Boundary rule (documented in README): an action is allowed iff
//   current_period_usage + requested_usage <= plan_limit
// A request that lands exactly on the limit is ALLOWED. The NEXT request
// (current == limit) violates the check and is rejected with 429.
//
// Payment gate: Pro-plan tenants must have an active/trialing subscription.
// Without one we reject 402 Payment Required before any usage is recorded.

const { usageSnapshot } = require('./meterService');

class QuotaExceededError extends Error {
  constructor(detail) {
    super('usage quota exceeded');
    this.name = 'QuotaExceededError';
    this.status = 429;
    this.detail = detail;
  }
}

class PaymentRequiredError extends Error {
  constructor(detail) {
    super('payment required');
    this.name = 'PaymentRequiredError';
    this.status = 402;
    this.detail = detail;
  }
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

/**
 * @param {Database} db
 * @param {object} tenant - { id, plan: { api_call_limit, token_limit }, subscription_status }
 * @param {number} requestedApiCalls
 * @param {number} requestedTokens - sum of all token types for the request
 * @param {string} period - 'YYYY-MM'
 * @returns {{ usage: object, allowed: true }}
 * @throws {QuotaExceededError} 429
 * @throws {PaymentRequiredError} 402
 */
function enforceQuota(db, tenant, requestedApiCalls, requestedTokens, period) {
  const plan = tenant.plan;

  if (plan.id !== 'free') {
    const status = tenant.subscription_status;
    if (!status || !ACTIVE_SUBSCRIPTION_STATUSES.has(status)) {
      throw new PaymentRequiredError({
        code: 'plan_inactive',
        message: `Subscription is not active for plan "${plan.id}" (status: ${status || 'none'}). Please update your payment method or resubscribe.`,
        plan: plan.id,
        subscription_status: status || null,
      });
    }
  }

  const usage = usageSnapshot(db, tenant.id, period, plan);
  const apiAfter = usage.api_calls.used + requestedApiCalls;
  const tokensAfter = usage.tokens.used + requestedTokens;

  if (apiAfter > plan.api_call_limit) {
    throw new QuotaExceededError({
      code: 'api_call_quota_exceeded',
      type: 'api_call',
      used: usage.api_calls.used,
      requested: requestedApiCalls,
      limit: plan.api_call_limit,
      message: `API call quota exceeded for plan "${plan.id}": used ${usage.api_calls.used} + ${requestedApiCalls} requested exceeds limit ${plan.api_call_limit} for period ${period}.`,
    });
  }

  if (tokensAfter > plan.token_limit) {
    throw new QuotaExceededError({
      code: 'token_quota_exceeded',
      type: 'token',
      used: usage.tokens.used,
      requested: requestedTokens,
      limit: plan.token_limit,
      message: `AI token quota exceeded for plan "${plan.id}": used ${usage.tokens.used} + ${requestedTokens} requested exceeds limit ${plan.token_limit} for period ${period}.`,
    });
  }

  return { usage, allowed: true };
}

module.exports = { enforceQuota, QuotaExceededError, PaymentRequiredError, ACTIVE_SUBSCRIPTION_STATUSES };