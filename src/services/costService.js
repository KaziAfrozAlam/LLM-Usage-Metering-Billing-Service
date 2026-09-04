// Cost calculation.
//
// Money is INTEGER micro-units (1 USD = 1,000,000 micro-units). All math uses
// BigInt — no floats anywhere.
//
// Pricing rules (config.TOKEN_PRICING, micros per 1,000 tokens):
//   fresh input: 3,000   cached input: 300   output: 15,000
// Rule A: cached input is cheaper than fresh input (0.30 vs 3.00 USD/1M).
// Rule B: reasoning tokens are billed as OUTPUT tokens (same 15,000 rate) —
//         `reasoning` is NOT a separate billable category.
// Rule C: totals are computed per-category with each event's own rate, then
//         summed. Categories are NEVER collapsed into a single token count
//         and priced once (naive sum). Evidence: EVIDENCE.md §Cost.

const config = require('../config');

/** Cost in micro-units (BigInt) for one usage event. */
function costMicrosFor(type, quantity) {
  if (!config.TOKEN_PRICING[type]) return 0n; // api_call and other non-billable categories are free
  const n = BigInt(quantity);
  const microsPer1K = config.TOKEN_PRICING[type].microsPer1K;
  if (type === 'reasoning') {
    // Rule B: reasoning -> output rate; reasoning per se has no rate.
    return (n * config.TOKEN_PRICING[config.REASONING_BILLED_AS].microsPer1K) / 1000n;
  }
  return (n * microsPer1K) / 1000n;
}

/** Total cost of a list of usage events (each applied its own rate, Rule C). */
function costMicrosForEvents(events) {
  let total = 0n;
  for (const ev of events) total += costMicrosFor(ev.type, ev.quantity);
  return total;
}

/** Cost of the period's grouped per-type totals (Rule C). */
function costMicrosForTotals(totals) {
  let total = 0n;
  for (const type of ['input', 'cached_input', 'output', 'reasoning']) {
    total += costMicrosFor(type, totals[type]);
  }
  return total;
}

/** Micro-units -> integer cents (each step integer). Returns an integer. */
function microsToCents(micros) {
  const b = BigInt(micros);
  const cents = (b * 100n) / config.MICRO_UNITS_PER_USD;
  return Number(cents);
}

/** Micro-units -> whole USD dollars (integer) for display. */
function microsToUsdWholeDollars(micros) {
  return Number(BigInt(micros) / config.MICRO_UNITS_PER_USD);
}

/** Build a human-safe money view of a BigInt cost. */
function moneyView(micros) {
  const n = BigInt(micros);
  const usd = Number(n) / 1_000_000;
  return {
    micro_units: Number(n),
    cents: Number((n * 100n) / config.MICRO_UNITS_PER_USD),
    usd: Number(usd.toFixed(6)),
  };
}

module.exports = {
  costMicrosFor,
  costMicrosForEvents,
  costMicrosForTotals,
  microsToCents,
  microsToUsdWholeDollars,
  moneyView,
};