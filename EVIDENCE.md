# EVIDENCE — Usage Metering & Billing Engine

One pasted proof per acceptance requirement. All transcripts below were produced by **running the
actual service** during this build (local server on `http://localhost:3000`, SQLite `dev.db`, seeded
via `npm run seed`).

- **Run:** `npm test` → 19/19 green (see §0).
- **Acceptance #1** idempotency (§1) · **#2** quota boundary (§2) · **#3** checkout Free→Pro (§3) ·
  **#4** forged/replay webhooks (§4) · **#5** pinned pricing (§Cost) · **stretch** alerts (§Alerts).

---

## §0 Test suite — `node --test tests/*.test.js`

```
ok 1 - pricing rules: exact totals for fresh/cached/reasoning tokens
ok 2 - usage route: GET /usage matches per-category totals
ok 3 - money is integers: cost API reports integer cents/micro-units
ok 4 - idempotent metering: duplicate key stores exactly one usage event
ok 5 - idempotent metering: request_responses has one row; usage unchanged on duplicate
ok 6 - quota boundary: exactly-on-limit allowed, next request 429
ok 7 - quota boundary: token quota exceeded returns 429
ok 8 - payment gate: Pro tenant without an active subscription -> 402
ok 9 - payment gate resets after an active subscription lands
ok 10 - rollup job produces correct monthly totals and cost
ok 11 - rollup is idempotent (upsert, safe to re-run)
ok 12 - boundary validation: missing body -> 400, never 500
ok 13 - no auth: missing API key -> 401
ok 14 - unknown route -> 404
ok 15 - forged webhook: bad signature -> 400 and no state change
ok 16 - valid signed webhook processed once; replay ignored as duplicate
ok 17 - webhook updates are applied only for verified, idempotent events
ok 18 - alerts fire at 80% then 100%, exactly once each
ok 19 - token 80% alert fires; retrieval is tenant-scoped
# tests 19
# pass 19
# fail 0
```

---

## §1 Acceptance #1 — Idempotent metering (real `POST /generate` twice, one key)

Request body (sent twice):
```json
{"idempotency_key":"req-001","prompt":"Hello world","max_output_tokens":100}
```

First call → `201`, `duplicate:false`:
```json
{"ok":true,"duplicate":false,"idempotency_key":"req-001","tenant_id":"tenant-free",
 "prompt_tokens":3,"output_tokens":100,"reasoning_tokens":0,"cache_input":false,
 "input_token_type":"input","api_calls_used":1,"tokens_used":103,
 "cost_micros":1509,"cost":{"micro_units":1509,"cents":0,"usd":0.001509}, ...}
```

Second call (same key) → mirrors the first exactly, `duplicate:true`:
```json
{"ok":true,"duplicate":true,"idempotency_key":"req-001","tenant_id":"tenant-free",
 "prompt_tokens":3,"output_tokens":100,"reasoning_tokens":0,"cache_input":false,
 "input_token_type":"input","api_calls_used":1,"tokens_used":103,
 "cost_micros":1509,"cost":{"micro_units":1509,"cents":0,"usd":0.001509},
 "duplicate_of_key":"req-001"}
```

DB after both calls — exactly one event set (sub-keys UNIQUE), one mirrored response:
```
usage_events: [{"type":"api_call","quantity":1,"idempotency_key":"req-001::api_call"},
               {"type":"input","quantity":3,"idempotency_key":"req-001::input"},
               {"type":"output","quantity":100,"idempotency_key":"req-001::output"}]
request_responses: { c: 1 }
```

---

## §2 Acceptance #2 — Quota boundary (used 999/1000 → exact-limit allowed → next 429)

Tenant driven to 999/1000 API calls, then two requests:

Request 1 (boundary: 999 + 1 = 1000 **== limit → ALLOWED**) → `201`:
```json
{"ok":true,"duplicate":false,"idempotency_key":"b1","tenant_id":"boundary",
 "prompt_tokens":2,"output_tokens":1,"reasoning_tokens":0,"cache_input":false,
 "input_token_type":"input","api_calls_used":1000,"tokens_used":3,
 "cost_micros":21,"cost":{"micro_units":21,"cents":0,"usd":0.000021},
 "message":"Generated 1 output tokens (simulated) for \"boundary...\"."}
HTTP_STATUS:201
```

Request 2 (1000 + 1 > 1000 → **REJECTED**) → `429` with clear message:
```json
{"error":"QuotaExceededError",
 "message":"API call quota exceeded for plan \"free\": used 1000 + 1 requested exceeds limit 1000 for period 2026-09.",
 "detail":{"code":"api_call_quota_exceeded","type":"api_call","used":1000,"requested":1,
   "limit":1000,"message":"API call quota exceeded for plan \"free\": used 1000 + 1 requested exceeds limit 1000 for period 2026-09."}}
HTTP_STATUS:429
```

Payment gate — Pro tenant with **no active subscription** → `402`:
```json
{"error":"PaymentRequiredError",
 "message":"Subscription is not active for plan \"pro\" (status: none). Please update your payment method or resubscribe.",
 "detail":{"code":"plan_inactive","message":"... resubscribe.","plan":"pro","subscription_status":null}}
HTTP_STATUS:402
```

---

## §3 Acceptance #3 — Stripe test Checkout → tenant Free→Pro, `GET /usage` shows new limits

Captured from `node scripts/demo_checkout_flow.js` (cryptographically signed event via
`stripe.webhooks.generateTestHeaderString`, sent exactly as the route verifies):

```
BEFORE checkout (Free plan):
{ "plan": {"id":"free"}, "api_calls": {"used":0,"limit":1000,"remaining":1000},
  "tokens": {"used":0,"limit":100000,"remaining":100000} }

POST signed checkout.session.completed webhook ->
HTTP 200 {"received":true,"event_id":"evt_demo_checkout_free_to_pro","type":"checkout.session.completed","processed":true,"async":true}

AFTER checkout (should be Pro):
{ "plan": {"id":"pro"}, "api_calls": {"used":0,"limit":50000,"remaining":50000},
  "tokens": {"used":0,"limit":5000000,"remaining":5000000} }

tenant row: {"id":"tenant-free","plan_id":"pro","status":"active","stripe_customer_id":"cus_demo_free_to_pro"}
subscription: {"plan_id":"pro","status":"active","stripe_subscription_id":"sub_demo_free_to_pro"}
```

The checkout flow endpoint (`POST /checkout/subscription`) creates a test-only Checkout session
(mode `subscription`); pay with `4242 4242 4242 4242`, any future expiry.

---

## §4 Acceptance #4 — Forged webhook → 400, nothing changes; replay → processed once

From `node scripts/simulate_webhook.js` (running against the live server):

```
== 1) FORGED WEBHOOK (garbled signature) -> expect 400 ==
HTTP 400 body: {"error":"SignatureVerificationFailed","message":"Webhook signature verification
failed: No signatures found matching the expected signature for payload. ..."}

== 2) VALID checkout.session.completed (tenant-free -> pro) ==
HTTP 200 body: {"received":true,"event_id":"evt_demo_checkout","type":"checkout.session.completed","processed":true,"async":true}

== 3) REPLAY of the SAME event id -> expect duplicate, processed once ==
HTTP 200 body: {"received":true,"event_id":"evt_demo_checkout","type":"checkout.session.completed","processed":false,"duplicate":true}
```

Dedup table after the sequence (`stripe_events` PK = event id → one row per unique event):
```
stripe_events rows: [{"id":"evt_demo_checkout","type":"checkout.session.completed"},
                     {"id":"evt_demo_sub_updated","type":"customer.subscription.updated"}]
```

Replay of a real event is ignored **even when re-sent with a valid signature** (the event id is the
dedup key). Also proven in `tests/webhook.test.js`: `stripe_events` count = 1 and subscriptions = 1
after processing the same checkout twice.

Full lifecycle on a fresh seed — checkout flips Free→Pro and a subsequent `customer.subscription.updated`
(→ canceled) downgrades back to Free:
```
== 2) VALID checkout.session.completed (tenant-free -> pro) ==
HTTP 200 {"received":true,"event_id":"evt_demo_checkout",...,"processed":true,"async":true}
== 4) VALID customer.subscription.updated (canceled -> downgrade tenant-free to free) ==
HTTP 200 {"received":true,"event_id":"evt_demo_sub_updated",...,"processed":true,"async":true}
tenant tenant-free: {"id":"tenant-free","plan_id":"free","status":"active"}
subscriptions: [{ "plan_id":"pro","status":"canceled","stripe_subscription_id":"sub_demo_123"}]
```

**Bonus — job retry/failure handling** (async WebhookQueue with backoff): when a handler cannot map
a stale customer it is retried (3 attempts with exponential backoff) and on permanent failure the
dedup marker is cleared so Stripe's re-delivery can succeed later. Real server log:
```
[queue] retry "webhook.process" (...) attempt 1: No tenant for Stripe customer "cus_demo_123"
[queue] retry "webhook.process" (...) attempt 2: No tenant for Stripe customer "cus_demo_123"
[queue] failed  "webhook.process" (...) attempt 3: No tenant for Stripe customer "cus_demo_123"
[queue] cleared dedup marker for webhook event evt_demo_sub_updated — it can be re-processed on redelivery.
```

---

## §Cost Acceptance #5 — Pinned pricing → exact expected totals, `GET /usage` matches

Unit-proof (integer micro-units, BigInt):

```
1,000,000 fresh input tokens   -> 3000000 micros = $3.00   (expect $3.00)
1,000,000 cached input tokens   -> 300000 micros = $0.30    (expect $0.30, cheaper than fresh)
1,000,000 output tokens         -> 15000000 micros = $15.00 (expect $15.00)
1,000,000 reasoning tokens      -> 15000000 micros = $15.00 (expect $15.00 = billed as OUTPUT, NOT a separate category)
Rule C counter-example: 1M input + 1M cached = 3300000 micros ($3.30)
   NOT naive single-rate sum 6000000 ($6.00)
```

Integration proof — `POST /generate` with `cache_input:true` + `reasoning_tokens:200` on a Pro
tenant (request cost `18008` micros), then `GET /usage` **matches exactly**:

```
POST /generate → 201:
{"...","prompt_tokens":29,"output_tokens":1000,"reasoning_tokens":200,"cache_input":true,
 "input_token_type":"cached_input","tokens_used":1229,
 "cost_micros":18008,"cost":{"micro_units":18008,"cents":1,"usd":0.018008}}

GET /usage → 200:
{"tenant_id":"tenant-free","period":"2026-09","plan":{"id":"pro","name":"Pro"},
 "api_calls":{"used":1,"limit":50000,"remaining":49999},
 "tokens":{"used":1229,"limit":5000000,"remaining":4998771},
 "cost":{"micro_units":18008,"cents":1,"usd":0.018008},
 "breakdown":{
   "input":{"used":0,"cost":{"micro_units":0}},
   "cached_input":{"used":29,"cost":{"micro_units":8}},     <- 29 * 300 / 1000 = 8
   "output":{"used":1000,"cost":{"micro_units":15000}},     <- 1000 * 15000 / 1000 = 15000
   "reasoning":{"used":200,"billed_as":"output","cost":{"micro_units":3000}}}}  <- 200 * 15000 / 1000 = 3000
```

Totals: 8 + 15,000 + 3,000 = **18,008 micros** — identical to the request cost and to
`GET /usage`. Categories are priced per-category; the naive single-rate sum of 1,229 tokens would
not equal 18,008.

Background rollup (`npm run rollup`) produces the same integer totals:
```
usage_rollups row: {"tenant_id":"tenant-free","period":"2026-09","api_calls":1,
  "cached_input_tokens":29,"output_tokens":1000,"reasoning_tokens":200,"cost_micros":18008}
```

---

## §Alerts Stretch — usage alerts at 80% / 100% (live transcript)

Tenant driven to 800/1000 API-call usage (80%), then:

```
=== generate #1: used=800, this request takes it to 801 -> crosses 80% target ===
{"ok":true,"duplicate":false,"idempotency_key":"alert-1","tenant_id":"tenant-free",...,
 "api_calls_used":801,"tokens_used":14,"cost_micros":162,
 "alerts":[{"metric":"api_call","threshold_pct":80}], ...}
[HTTP 201]

=== generate #2: used=999, lands exactly on 1000 -> 100% alert ===
{"ok":true,"duplicate":false,"idempotency_key":"alert-2",...,
 "api_calls_used":1000, ..., "alerts":[{"metric":"api_call","threshold_pct":100}], ...}
[HTTP 201]

=== generate #3: next -> 429 (no recording, no re-alert) ===
{"error":"QuotaExceededError","message":"API call quota exceeded for plan \"free\": used 1000 + 1
 requested exceeds limit 1000 for period 2026-09.",...}
[HTTP 429]

=== GET /usage/alerts (deduped: each threshold fires exactly once) ===
{"tenant_id":"tenant-free","period":"2026-09","alerts":[
 {"tenant_id":"tenant-free","period":"2026-09","metric":"api_call","threshold_pct":80,"created_at":"2026-09-04T18:26:14.648Z"},
 {"tenant_id":"tenant-free","period":"2026-09","metric":"api_call","threshold_pct":100,"created_at":"2026-09-04T18:26:21.973Z"}]}
[HTTP 200]
```