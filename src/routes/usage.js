const { Router } = require('express');
const { asyncHandler } = require('../middleware/errors');
const { tenantAuth } = require('../middleware/tenantAuth');
const { totalsByType, usageSnapshot, periodOf } = require('../services/meterService');
const { costMicrosForTotals, moneyView } = require('../services/costService');
const { alertsFor } = require('../services/alertService');

/**
 * GET /usage
 * Monthly rollup per tenant: { period, api_calls, tokens, cost, breakdown }.
 * Cost is computed with per-category rates (cached input cheaper; reasoning
 * billed as output) — not a naive sum of all tokens at one rate.
 */
module.exports = function usageRouter(db) {
  const router = Router();
  router.use(tenantAuth(db));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const tenant = req.tenant;
      const period = req.query.period ? String(req.query.period) : periodOf();

      const totals = totalsByType(db, tenant.id, period);
      const usage = usageSnapshot(db, tenant.id, period, tenant.plan);
      const costMicros = costMicrosForTotals(totals);

      const breakdown = {
        api_calls: { used: totals.api_call },
        input: { used: totals.input, cost: moneyView(costMicrosForTotals({ ...empty(), input: totals.input })) },
        cached_input: { used: totals.cached_input, cost: moneyView(costMicrosForTotals({ ...empty(), cached_input: totals.cached_input })) },
        output: { used: totals.output, cost: moneyView(costMicrosForTotals({ ...empty(), output: totals.output })) },
        reasoning: {
          used: totals.reasoning,
          billed_as: 'output',
          cost: moneyView(costMicrosForTotals({ ...empty(), reasoning: totals.reasoning })),
        },
      };

      res.json({
        tenant_id: tenant.id,
        period,
        plan: { id: tenant.plan.id, name: tenant.plan.name },
        api_calls: usage.api_calls,
        tokens: usage.tokens,
        cost: moneyView(costMicros),
        breakdown,
      });
    })
  );

  router.get(
    '/alerts',
    asyncHandler(async (req, res) => {
      const tenant = req.tenant;
      const period = req.query.period ? String(req.query.period) : periodOf();
      res.json({ tenant_id: tenant.id, period, alerts: alertsFor(db, tenant.id, period) });
    })
  );

  return router;
};

function empty() {
  return { input: 0, cached_input: 0, output: 0, reasoning: 0 };
}