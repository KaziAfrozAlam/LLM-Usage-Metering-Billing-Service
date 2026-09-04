const { createDb, applyMigrations } = require('../src/db');
const { createApp } = require('../src/app');
const { JobQueue } = require('../src/jobs/queue');
const { registerJobs } = require('../src/jobs');
const config = require('../src/config');

/** Test harness: fresh in-memory DB + app + queue for every test. */
function makeContext() {
  const db = createDb(':memory:');
  applyMigrations(db);
  seed(db);

  const queue = new JobQueue({ maxAttempts: 2, baseBackoffMs: 10 });
  registerJobs(queue, db);

  const app = createApp(db, queue);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  return { db, queue, app, server, base, close };
}

function seed(db) {
  const upsertPlan = db.prepare(`
    INSERT INTO plans (id, name, api_call_limit, token_limit, price_cents)
    VALUES (@id, @name, @api_call_limit, @token_limit, @price_cents)
    ON CONFLICT (id) DO UPDATE SET api_call_limit=excluded.api_call_limit, token_limit=excluded.token_limit, price_cents=excluded.price_cents
  `);
  upsertPlan.run(config.PLANS.free);
  upsertPlan.run(config.PLANS.pro);

  const addTenant = db.prepare('INSERT INTO tenants (id, name, api_key, plan_id, status) VALUES (?, ?, ?, ?, \'active\')');
  addTenant.run('t-free', 'Free Tenant', 'key-free', 'free');
  addTenant.run('t-pro', 'Pro Tenant', 'key-pro', 'pro');
}

async function close(ctx) {
  await new Promise((resolve) => ctx.server.close(resolve));
  ctx.queue.drainNow().then(() => {
    try {
      ctx.db.close();
    } catch {}
  });
}

/** HTTP helper returning { status, json }. */
async function call(ctx, method, path, { headers = {}, body, rawBody } = {}) {
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : rawBody,
  });
  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json, text };
}

const gen = (key, over = {}) => ({ idempotency_key: key, prompt: 'hello metering world', max_output_tokens: 10, ...over });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { makeContext, call, gen, sleep, close };