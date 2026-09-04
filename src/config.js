require('dotenv').config();

const MICRO_UNITS_PER_USD = 1_000_000n;

// Token pricing in integer micro-dollars per 1,000 tokens (1 USD = 1,000,000 micro-units).
// Proven totals (see EVIDENCE.md):
//   fresh input   : 3,000 micros / 1K tokens  -> $3.00 per 1M tokens
//   cached input  :   300 micros / 1K tokens  -> $0.30 per 1M tokens  (10x cheaper than fresh)
//   output        : 15,000 micros / 1K tokens -> $15.00 per 1M tokens
const TOKEN_PRICING = Object.freeze({
  input: { microsPer1K: 3_000n, label: 'fresh input' },
  cached_input: { microsPer1K: 300n, label: 'cached input' },
  output: { microsPer1K: 15_000n, label: 'output' },
  // Reasoning tokens are billed as OUTPUT tokens (same rate), NOT a separate category.
  reasoning: { microsPer1K: 15_000n, label: 'reasoning (billed as output)' },
});

// The same rate used when a "reasoning" usage event is converted to the billable
// output category during rollup. Spec: categories cannot simply be summed.
const REASONING_BILLED_AS = 'output';

// Monthly plan limits (per calendar month, UTC).
const PLANS = Object.freeze({
  free: {
    id: 'free',
    name: 'Free',
    api_call_limit: 1_000,
    token_limit: 100_000, // AI tokens, all token types combined
    price_cents: 0,
    stripe: null,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    api_call_limit: 50_000,
    token_limit: 5_000_000,
    price_cents: 1_999, // $19.99 / month
    stripe: { price_id: process.env.STRIPE_PRICE_PRO || '' },
  },
});

// Simulated token counting rule for the dummy billable endpoint (
// deterministic, no real model calls):
//   input = max(1, ceil(textByteLength / 4))
const TOKEN_SIMULATION = Object.freeze({
  CHAR_RATIO: 4,
  DEFAULT_OUTPUT_TOKENS: 500,
  MAX_OUTPUT_TOKENS: 4_096,
  MAX_REASONING_TOKENS: 4_096,
});

const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseFile: process.env.DATABASE_FILE || 'dev.db',
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    mode: 'test', // never live
  },
  rollupIntervalMs: Number(process.env.ROLLUP_INTERVAL_MS || 0), // 0 = disabled; run `npm run rollup` instead
  job: {
    maxAttempts: Number(process.env.JOB_MAX_ATTEMPTS || 3),
    baseBackoffMs: Number(process.env.JOB_BASE_BACKOFF_MS || 250),
  },
  TOKEN_PRICING,
  REASONING_BILLED_AS,
  PLANS,
  TOKEN_SIMULATION,
  MICRO_UNITS_PER_USD,
};

module.exports = config;