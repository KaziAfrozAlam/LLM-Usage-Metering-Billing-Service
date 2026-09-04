const { Router } = require('express');
const { asyncHandler, HttpError } = require('../middleware/errors');
const { makeValidator, STR } = require('../middleware/validate');
const { tenantAuth } = require('../middleware/tenantAuth');
const { createCheckoutSession } = require('../services/stripeService');
const { getPlan } = require('../services/repo');

const validateCheckout = makeValidator({ plan: STR }, { allowJson: true });

/**
 * POST /checkout/subscription
 * Body: { plan: 'pro' }
 * Creates a Stripe Checkout session (mode = subscription) in TEST MODE.
 * Pay with test card 4242 4242 4242 4242 (any future expiry, any CVC).
 */
module.exports = function checkoutRouter(db) {
  const router = Router();
  router.use(tenantAuth(db));

  router.post(
    '/subscription',
    validateCheckout,
    asyncHandler(async (req, res) => {
      const planId = (req.validated.plan || '').toLowerCase();
      const plan = getPlan(db, planId);
      if (!plan) throw new HttpError(400, `Unknown plan "${planId}". Available plans: free, pro`);
      if (plan.price_cents <= 0) throw new HttpError(400, `Plan "${planId}" is free and needs no checkout.`);

      const { session } = await createCheckoutSession(db, req.tenant, plan, {
        success_url: req.body && req.body.success_url,
        cancel_url: req.body && req.body.cancel_url,
      });

      res.status(201).json({
        session_id: session.id,
        url: session.url,
        mode: session.mode,
        plan: plan.id,
        price: session.amount_total,
        currency: session.currency,
        test_mode: true,
        note: 'Stripe TEST MODE. Pay with 4242 4242 4242 4242 (any future expiry).',
      });
    })
  );

  router.get(
    '/price/:plan',
    asyncHandler(async (req, res) => {
      const plan = getPlan(db, req.params.plan);
      if (!plan) throw new HttpError(404, `Unknown plan "${req.params.plan}".`);
      res.json({
        id: plan.id,
        name: plan.name,
        api_call_limit: plan.api_call_limit,
        token_limit: plan.token_limit,
        price_cents: plan.price_cents,
      });
    })
  );

  return router;
};