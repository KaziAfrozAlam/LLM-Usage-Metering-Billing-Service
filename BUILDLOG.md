# BUILDLOG — Honest AI-usage log

This file records how AI (the coding assistant) helped build the capstone, where it was **wrong**,
and what a human changed or decided.

---

## Where AI helped

- **Scaffolding**: generated the whole project structure (Express app factory, services, routes,
  migrations, jobs, tests) from a single-paragraph spec.
- **Domain modeling**: translated the requirements into concrete decisions — idempotency via a UNIQUE
  `idempotency_key` constraint with derived per-type sub-keys, integer micro-unit money, per-category
  token pricing (cached cheaper, reasoning billed as output), 429 vs 402 semantics, exact-limit
  boundary rule.
- **Thinking through edge cases**: duplicate request must not re-run quota/cost; quota must be
  checked *before* recording; webhook handler must be idempotent *and* async; rollup must be
  re-runnable (upsert).
- **Stripe specifics**: signature verification with `stripe.webhooks.constructEvent` on the raw body,
  dedup by event id, test-card prompts, and generating *valid* signed test events locally via
  `stripe.webhooks.generateTestHeaderString` so the cryptography is actually exercised without live
  keys.
- **Testing**: generated the full `node:test` suite (17 cases) and iterated until green.
- **Docs**: drafted README / capstone.yaml / EVIDENCE skeleton from real transcripts.

## Where AI was wrong (and what was changed)

1. **Optional-field bug** — the first `makeValidator` required *every* schema field as mandatory, so
   `POST /generate` rejected requests that omitted `reasoning_tokens`. Fix: validator now only
   requires declared `requiredFields` and type-checks whatever is present.
2. **Raw-body double encoding in the evidence script** — `scripts/simulate_webhook.js` re-serialized
   an already-JSON-stringified payload, so *every* `stripe-signature` mismatched (even valid ones).
   The route was fine; the test client was not. Fixed by sending the signed payload byte-for-byte.
3. **Customer→tenant link missing** — `customer.subscription.updated` handlers could not map a Stripe
   customer back to a tenant because `checkout.session.completed` didn't persist `stripe_customer_id`
   on the tenant. Discovered from a real failure log ("No tenant for Stripe customer …"). Fixed with
   `stripe_customer_id = COALESCE(stripe_customer_id, ?)` at checkout time.
4. **Rollup shorthand typo** — `cost_micros,` vs `costMicros` in `src/jobs/rollup.js`
   (`ReferenceError` after the row was written). Caught by running the job; the row had still been
   persisted, confirming the query worked.
5. **Duplicate-status semantics** — initial duplicates returned `200` while the original returned
   `201`, which contradicts "second response mirrors the first". Changed duplicates to return the
   identical `201` body plus a `duplicate: true` flag (Stripe-style 200 was defensible, but a strict
   mirror is easier to validate against the acceptance checklist).
6. **PowerShell/Shell friction** — `&&`, `npm.ps1` execution policy, JSON escaping in `curl -d`
   worked around with single-bash-tool edits and body files. No code changes needed, but several
   evidence runs had to be redone cleanly.

## Stretch goal round (usage alerts at 80%/100%)

- **Feature added cleanly**: migration `002_alerts.sql`, `alertService.js`, evaluation hooks in
  `POST /generate` and the rollup job, `GET /usage/alerts`, plus `tests/alerts.test.js`. Alerts are
  deduped by `UNIQUE (tenant_id, period, metric, threshold_pct)` so each threshold fires once/month.
- **AI mistakes found in this round**:
  - Introduced a duplicate `const { recordRequest, periodOf } = require(...)` line in `generate.js`
    (`SyntaxError: Identifier 'recordRequest' has already been declared`) — caught immediately by the
    test runner and fixed.
  - First alerts test tried to cross 100% by planting 1000 rows then generating — the request was
    correctly rejected `429` *before* recording, so no 100% alert fired. Reworked the test to land
    exactly on the limit (999 → +1 = 1000), which matches the documented boundary rule.
  - A `.sort()` on threshold numbers sorted lexicographically (`[100, 80]`), so a valid assertion
    failed — fixed with a numeric comparator.
- **Pre-commit audit caught two packaging bugs** (`npm` scripts were never used until the commit
  pass, so the README-documented entrypoints had silently rotted):
  - `package.json` had a trailing comma — invalid strict JSON; `npm test`/`npm run seed` would
    crash. Removed.
  - `npm run migrate` pointed at a nonexistent `src/db/migrate.js`; the real entrypoint is
    `src/db/index.js` (runs on server open and stand-alone). Script fixed. Also pruned the unused
    `pg` dependency from `package.json` + lockfile.

## Human decisions stamped into the build

- Chose Node.js + Express over FastAPI, and **SQLite** (`better-sqlite3`) over Postgres/Docker
  (spec explicitly allows either).
- Prices pinned as **integer micro-dollars per 1,000 tokens** (input 3,000 · cached 300 · output
  15,000 micros) — per-token pricing would be fractional, so the unit is per-1K.
- Plan limits documented: Free 1,000 calls / 100k tokens; Pro 50,000 calls / 5M tokens at $19.99/mo.
- Exact-limit boundary rule: `current + requested <= limit` is allowed (landing on the limit OK).
- An idempotency key covers a whole billable request; `usage_events` rows use derived sub-keys
  (`<key>::<type>`) so the UNIQUE constraint on `idempotency_key` stays the dedup boundary, and the
  original response is mirrored back from `request_responses`.

## Verification performed

- `npm test` → **17/17 passing** (idempotency, quota boundary + 402, cost/pricing, webhook forged +
  replay, rollup, boundary validation).
- Live server runs: duplicate `POST /generate`, quota-boundary curl transcript, `GET /usage` cost
  match, forged → 400 / signed → processed-once / replay → duplicate, Free→Pro checkout flip with
  `/usage` limit change — all recorded in `EVIDENCE.md`.
- Everything above was observed and pasted, not invented.