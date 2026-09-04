# Usage Metering & Billing Engine (FlyRank Capstone)

A backend service that **meters customer usage**, **enforces plan quotas**, **prices AI-token
usage** (including cached-input and reasoning tokens), and **syncs subscriptions with Stripe/RazorPay in
TEST MODE**. Built with Node.js + Express, SQLite (via `better-sqlite3`), and the Stripe/RazorPay SDK.

> Money is stored as **integer micro-units** (1 USD = 1,000,000 micro-units). No floats anywhere.

---

## What it does

| Capability | Endpoint / component | Notes |
|---|---|---|
| Idempotent metering | `POST /generate` | same idempotency key twice -> exactly one usage event, second call mirrors the first |
| Quota enforcement | `POST /generate` | `429` quota exceeded · `402` payment/plan issue, clear messages |
| Cost rollup | `GET /usage` | monthly used/limit per tenant + integer cost + per-category breakdown |
| Stripe checkout (test only) | `POST /checkout/subscription` | creates a Stripe Checkout subscription session |
| Stripe webhooks | `POST /webhooks/stripe` | signed, deduplicated, async with retry |
| Usage alerts | evaluated on `POST /generate` + rollup; `GET /usage/alerts` | one-time 80% / 100% alerts per metric per month |
| Background jobs | async webhook queue + `npm run rollup` | retries with backoff, failure handling |

---

## Architecture

```
Client → POST /generate { idempotency_key, prompt, ... }
  → MeterService.recordRequest(tenant, {api_call, input/cached_input, output, reasoning}, key)
      | duplicate key? → return original result (no new events)
      | store usage_events (idempotency_key UNIQUE)
  → EnforceQuota (current + requested vs plan limit)  [402 / 429 before any write]
  → CostService (per-category rates, BigInt micro-units)

GET /usage ← rollup(usage_events) → { api_calls, tokens, cost, breakdown }

Stripe Checkout (test mode) → customer.subscription -> webhook
POST /webhooks/stripe
  | verify signature (Stripes' constructEvent; forged → 400)
  | deduplicate event id (stripe_events PK; replay → ignored)
  | enqueue async job (JobQueue: retry + backoff) → update tenant plan/status
```

Layering: `src/services/*` (data + domain logic) ← `src/routes/*` (HTTP) ← `src/middleware/*`
(boundary validation/auth) with a shared `config` of pinned constants.

```
src/
  config.js                  pinned pricing constants, plan limits, env
  db/
    index.js                 SQLite connection + migration runner
    migrations/001_init.sql  schema (tenants, plans, subscriptions, usage_events,
                             request_responses, stripe_events, usage_rollups) + indexes
    seed.js                  `npm run seed` — plans + demo tenants (+ Stripe price)
  services/
    meterService.js          idempotent usage recording, period helpers
    quotaService.js          quota + payment gate (429 / 402)
    costService.js           integer (BigInt) cost computation
    alertService.js          one-time 80%/100% usage alerts (stretch)
    stripeService.js         test-mode Stripe helpers, Checkout sessions
    subscriptionService.js   Stripe-event → tenant plan/status sync (single source of truth)
    repo.js                  data access scoped by tenant (isolation)
  jobs/
    queue.js                 in-process job queue (retry + exponential backoff)
    index.js                 registers webhook.process + rollup.run handlers
    rollup.js                monthly rollup cache (`npm run rollup`, or scheduled)
  routes/                    generate · usage · checkout · webhooks
  middleware/                tenantAuth (X-API-Key), validate (boundary), errors
  app.js / server.js
tests/                       17 node:test cases (idempotency, quota, cost, webhooks, rollup)
scripts/                     simulate_webhook.js · demo_checkout_flow.js (evidence scripts)
```

---

## Plans & quota limits (documented, month = UTC calendar month)

| Plan | API calls / month | AI tokens / month | Price |
|---|---|---|---|
| `free` | 1,000 | 100,000 | $0.00 |
| `pro`  | 50,000 | 5,000,000 | $19.99 / mo |

**Boundary rule (exact):** an action is allowed iff `current_month_usage + requested <= limit`.

- A request that lands **exactly on the limit is ALLOWED** (e.g. used 999 + 1 requested = 1000 = limit → 201).
- The **next** request (used 1000 + 1 > 1000) is rejected with **429** and a message that includes
  used / requested / limit / period.
- The same rule applies to the combined AI-token bucket (all token categories count toward the one
  token limit).

---

## AI token pricing (pinned in `src/config.js`)

Per 1,000 tokens, integer micro-dollars (1 USD = 1,000,000 micro-units):

| Category | micros / 1K | USD / 1M tokens |
|---|---|---|
| `input` (fresh) | 3,000 | $3.00 |
| `cached_input` | 300 | $0.30 (10× cheaper than fresh) |
| `output` | 15,000 | $15.00 |
| `reasoning` | **billed as `output`** (15,000) | $15.00 — not a separate category |

Rules encoded in `CostService`:
- **Rule A** — cached input is cheaper than fresh input (`.30` vs `3.00` per 1M).
- **Rule B** — reasoning tokens are priced at the output rate; `reasoning` has no rate of its own.
- **Rule C** — totals are computed **per category with each event's own rate then summed**; we never
  collapse categories into one token count and price it once (a naive sum is wrong).

Money math uses `BigInt` (`quantity * rate / 1000`, integer floor). Proof with exact totals: see
`EVIDENCE.md` §Cost.

---

## API

All billable endpoints require `X-API-Key`.

| Method & path | Body | Result |
|---|---|---|
| `GET /health` | — | service health |
| `GET /plans` | — | plan list with limits |
| `POST /generate` | `{ idempotency_key, prompt, max_output_tokens?, reasoning_tokens?, cache_input? }` | `201` usage summary / `200` mirror for duplicates; `429` quota; `402` payment |
| `GET /usage?period=YYYY-MM` | — | used/limit + cost + per-category breakdown |
| `GET /usage/alerts?period=YYYY-MM` | — | alerts fired this period (80% / 100% thresholds) |
| `POST /checkout/subscription` | `{ plan: 'pro' }` | `201` Stripe Checkout session (test mode, `4242 4242 4242 4242`) |
| `GET /checkout/price/:plan` | — | plan details |
| `POST /webhooks/stripe` | raw body + `stripe-signature` | `200` processed / duplicate; `400` forged; `503` not configured |

`POST /generate` records **one** `usage_events` row per usage type under derived sub-keys of the
request key (e.g. `req-001::api_call`). A full duplicate request is deduplicated up front and the
**original response** (stored in `request_responses`) is returned.

---

## Quick start

Requires **Node.js ≥ 18** (tested on Node 22). No Docker needed — SQLite.

```bash
npm install
cp .env.example .env          # then fill in Stripe TEST keys (optional for API-only flow)
npm run migrate
npm run seed
npm start
```

Demo tenants created by `npm run seed`:

| tenant | API key | plan |
|---|---|---|
| `tenant-free` | `key_demo_free` | free |
| `tenant-pro` | `key_demo_pro` | pro (payment gate on until subscription active) |

Try it:

```bash
curl -s -X POST http://localhost:3000/generate \
  -H "X-API-Key: key_demo_free" -H "Content-Type: application/json" \
  -d '{"idempotency_key":"req-001","prompt":"Hello world","max_output_tokens":100}'
# send the SAME body again -> duplicate:true, nothing double-charged

curl -s http://localhost:3000/usage -H "X-API-Key: key_demo_free"
```

### Stripe (test mode) — full checkout flow

1. Get **test** keys: Stripe Dashboard → Developers → API keys (mode: Test).
2. `STRIPE_SECRET_KEY=sk_test_...` in `.env`, then re-run `npm run seed` — it auto-creates the Pro
   product + price in test mode (or set `STRIPE_PRICE_PRO` to an existing price id).
3. Start the CLI and forward to the local webhook endpoint:

   ```bash
   stripe listen --forward-to localhost:3000/webhooks/stripe
   # copy the whsec_... secret into .env as STRIPE_WEBHOOK_SECRET, restart server
   ```

4. `POST /checkout/subscription { "plan": "pro" }` with an API key → open the returned `url` and pay
   with **`4242 4242 4242 4242`** (any future expiry, any CVC).
5. `checkout.session.completed` lands on the webhook → tenant plan flips to `pro` → `GET /usage`
   shows 50,000 / 5,000,000 limits.

**No public URL/tunnel needed** — `stripe listen` forwards locally. To demo the webhook pipeline
without the CLI, run `node scripts/simulate_webhook.js` (signs events with Stripe's own crypto and
crosses signature verification + dedup + forged-rejection).

### Stretch goal — usage alerts (80% / 100%)

Each time usage is recorded (`POST /generate`) and on every rollup run, thresholds are evaluated for
the tenant's current period: **80%** and **100%** of the API-call and AI-token limits. Each
(tenant, period, metric, threshold) fires **exactly once** (UNIQUE constraint + `INSERT OR IGNORE`).

Boundary semantics match quota enforcement: an alert reflects **recorded** usage, so the 100% alert
fires on the request that lands exactly on the limit (the next request is a `429`).

```
POST /generate (crosses 800/1000) -> "alerts":[{"metric":"api_call","threshold_pct":80}]
POST /generate (lands on 1000/1000) -> "alerts":[{"metric":"api_call","threshold_pct":100}]
GET /usage/alerts -> [{threshold_pct:80},{threshold_pct:100}]   (one each, deduped)
```

---

## Testing & background jobs

```bash
npm test            # 19 deterministic cases (node:test, in-memory DB)
npm run rollup      # recompute monthly usage_rollups cache (+ evaluate alerts)
ROLLUP_INTERVAL_MS=60000 npm start   # schedule rollup as a background job every 60s
```

Webhook events are processed **asynchronously**: the HTTP handler verifies + dedups + enqueues, then
responds `200` immediately. The `JobQueue` retries with exponential backoff (default 3 attempts, 250ms
base). If a webhook handler permanently fails it logs the error and clears its dedup marker so a
Stripe re-delivery can be processed again.

---

## Acceptance checklist — where each requirement is proven

1. **Idempotent metering** — `tests/metering.test.js` + `EVIDENCE.md` §1 (single event stored, duplicate mirrors).
2. **Quota boundary** — `tests/quota.test.js` (exactly-on-limit allowed, next → 429) + §2 boundary transcript.
3. **Checkout → Free → Pro** — `scripts/demo_checkout_flow.js` + `EVIDENCE.md` §3 (`GET /usage` shows new limits).
4. **Forged webhook 400 / replay dedup** — `tests/webhook.test.js` + `EVIDENCE.md` §4.
5. **Pinned pricing exact totals** — `tests/cost.test.js` + `EVIDENCE.md` §Cost (`GET /usage` matches).
6. **Stretch: 80%/100% alerts (one-time)** — `tests/alerts.test.js` + `EVIDENCE.md` §Alerts.

---

## Honest limitations

- **Local SQLite**, not Postgres/Docker — acceptable per scope, but a Postgres migration would
  require `ON CONFLICT`-equivalent upserts already present (SQL is ported in `001_init.sql`).
- **Simulated token counts** (deterministic, `ceil(textBytes/4)` input + explicit output/reasoning
  quantities) — no real model calls, per scope.
- **Stripe keys are not exercised in this repo's automated CI** (no live/remote Stripe in tests) —
  but the full signed-webhook cryptography IS verified locally using `stripe.webhooks`.
  To run the real checkout you need test-mode keys + `stripe listen` (documented above).
- **In-process job queue** — retries/backoff/failure handling yes, but no durable queue/broker;
  jobs survive only within a process run (acceptable capstone scope).
- Webhook ordering is **at-least-once with dedup, not exactly-once across failures**; the dedup
  marker clears on permanent failure to let Stripe's own redelivery retry.
- No invoicing/proration/overage billing in core (explicit scope boundary). The implemented stretch
  goal is **usage alerts at 80%/100%**.
- Rollup cost uses **floor integer division** per event (sub-micro rounding biases cannot accumulate
  across read backs since the same integer is stored and re-rolled-up).
