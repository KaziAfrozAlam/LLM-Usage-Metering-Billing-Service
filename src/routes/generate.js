const { Router } = require('express');
const { asyncHandler, HttpError } = require('../middleware/errors');
const { makeValidator, STR, INT } = require('../middleware/validate');
const { tenantAuth } = require('../middleware/tenantAuth');
const { recordRequest, periodOf } = require('../services/meterService');
const { enforceQuota, QuotaExceededError, PaymentRequiredError } = require('../services/quotaService');
const { costMicrosForEvents, moneyView } = require('../services/costService');
const { evaluateAlerts } = require('../services/alertService');
const config = require('../config');

const MAX_OUTPUT = config.TOKEN_SIMULATION.MAX_OUTPUT_TOKENS;
const MAX_REASONING = config.TOKEN_SIMULATION.MAX_REASONING_TOKENS;
const DEFAULT_OUTPUT = config.TOKEN_SIMULATION.DEFAULT_OUTPUT_TOKENS;

const validateGenerate = makeValidator(
  {
    idempotency_key: STR,
    prompt: STR,
    max_output_tokens: INT,
    reasoning_tokens: INT,
  },
  { allowJson: true, requiredFields: new Set(['idempotency_key', 'prompt']) }
);

/** Deterministic simulated token counts (no real model calls). */
function simulateTokens(prompt, opts) {
  const bytes = Buffer.byteLength(String(prompt), 'utf8');
  const input = Math.max(1, Math.ceil(bytes / config.TOKEN_SIMULATION.CHAR_RATIO));
  const output = Math.min(MAX_OUTPUT, Math.max(1, opts.max_output_tokens ?? DEFAULT_OUTPUT));
  const reasoning = opts.reasoning_tokens ? Math.min(MAX_REASONING, Math.max(0, opts.reasoning_tokens)) : 0;
  const inputType = opts.cache_input ? 'cached_input' : 'input';
  return { input, inputType, output, reasoning };
}

/**
 * POST /generate
 * Body: { idempotency_key, prompt, max_output_tokens?, reasoning_tokens?, cache_input? }
 * Billable action: 1 API call + simulated AI tokens. Idempotency-keyed.
 * Behavior:
 *   - duplicate key  -> 200 with the ORIGINAL response (no new usage, no re-charges)
 *   - quota exceeded -> 429 with clear message
 *   - inactive paid plan -> 402 with clear message
 */
module.exports = function generateRouter(db) {
  const router = Router();
  router.use(tenantAuth(db));

  router.post(
    '/',
    validateGenerate,
    asyncHandler(async (req, res) => {
      const { idempotency_key, prompt, max_output_tokens, reasoning_tokens, cache_input } = req.validated;
      const tenant = req.tenant;

      if (!idempotency_key || !idempotency_key.trim()) {
        throw new HttpError(400, 'Field "idempotency_key" is required.');
      }
      if (!prompt || prompt.trim() === '') {
        throw new HttpError(400, 'Field "prompt" is required and must be non-empty.');
      }

      const period = periodOf();

      // 1) Idempotency: return the original stored result if this key was already
      //    accepted for this tenant.
      const stored = db
        .prepare('SELECT response FROM request_responses WHERE idempotency_key = ? AND tenant_id = ?')
        .get(idempotency_key, tenant.id);
      if (stored) {
        return res.status(201).json({
          ...JSON.parse(stored.response),
          duplicate: true,
          duplicate_of_key: idempotency_key,
        });
      }

      // 2) Simulate token usage.
      const sim = simulateTokens(prompt, { max_output_tokens, reasoning_tokens, cache_input });
      const requestedTokens = sim.input + sim.output + sim.reasoning;

      // 3) Quota enforcement BEFORE recording (402 / 429 leave usage untouched).
      let usage;
      try {
        usage = enforceQuota(db, tenant, 1, requestedTokens, period).usage;
      } catch (err) {
        if (err instanceof QuotaExceededError || err instanceof PaymentRequiredError) {
          return res.status(err.status).json({ error: err.name, message: err.detail.message, detail: err.detail });
        }
        throw err;
      }

      // 4) Record usage idempotently (per-type sub-keys under the request key).
      const usageByType = {
        api_call: 1,
        [sim.inputType]: sim.input,
        output: sim.output,
        ...(sim.reasoning > 0 ? { reasoning: sim.reasoning } : {}),
      };
      const recorded = recordRequest(db, tenant.id, usageByType, idempotency_key);
      if (recorded.isDuplicate) {
        const dupStored = db
          .prepare('SELECT response FROM request_responses WHERE idempotency_key = ? AND tenant_id = ?')
          .get(idempotency_key, tenant.id);
        const base = dupStored ? JSON.parse(dupStored.response) : {};
        return res.status(201).json({ ...base, duplicate: true, duplicate_of_key: idempotency_key });
      }

      // 5) Cost for this request's token events (per-category rates).
      const costMicros = costMicrosForEvents(recorded.events);

      // 6) Usage alerts (80%/100%) — evaluated after recording. Non-blocking:
      //    an alert failure must never fail the billable request.
      let alerts = [];
      try {
        alerts = evaluateAlerts(db, tenant, period);
      } catch (err) {
        console.error(`[alerts] evaluation failed for ${tenant.id}:`, err.message);
      }

      const response = {
        ok: true,
        duplicate: false,
        idempotency_key,
        tenant_id: tenant.id,
        prompt_tokens: sim.input,
        output_tokens: sim.output,
        reasoning_tokens: sim.reasoning,
        cache_input: Boolean(cache_input),
        input_token_type: sim.inputType,
        api_calls_used: usage.api_calls.used + 1,
        tokens_used: usage.tokens.used + requestedTokens,
        cost_micros: Number(costMicros),
        cost: moneyView(costMicros),
        alerts: alerts.map((a) => ({ metric: a.metric, threshold_pct: a.threshold_pct })),
        message: `Generated ${sim.output} output tokens (simulated) for "${prompt.slice(0, 32)}...".`,
      };

      // 7) Mirror the response so a duplicate request returns the exact original.
      db.prepare(
        'INSERT INTO request_responses (idempotency_key, tenant_id, response) VALUES (?, ?, ?)'
      ).run(idempotency_key, tenant.id, JSON.stringify(response));

      res.status(201).json(response);
    })
  );

  return router;
};