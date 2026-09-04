const config = require('./config');
const { createDb, applyMigrations } = require('./db');
const { createApp } = require('./app');
const { JobQueue } = require('./jobs/queue');
const { registerJobs } = require('./jobs');

const db = createDb();
applyMigrations(db);

const queue = new JobQueue();
queue.onError(({ kind, job, error }) => {
  console.error(`[queue] ${kind} "${job.name}" (${job.id}) attempt ${job.attempt}:`, error.message);
  // If a webhook handler permanently fails, drop its dedup marker so a future
  // Stripe re-delivery can be processed again.
  if (kind === 'failed' && job.name === 'webhook.process') {
    try {
      const eventId = job.payload && job.payload.event && job.payload.event.id;
      if (eventId) {
        db.prepare('DELETE FROM stripe_events WHERE id = ?').run(eventId);
        console.warn(`[queue] cleared dedup marker for webhook event ${eventId} — it can be re-processed on redelivery.`);
      }
    } catch (err) {
      console.error('[queue] failed to clear dedup marker:', err.message);
    }
  }
});
registerJobs(queue, db);

const app = createApp(db, queue);

// Optional background scheduler for the nightly-style rollup.
if (config.rollupIntervalMs > 0) {
  const tick = () => {
    try {
      queue.enqueue('rollup.run', {});
    } catch (err) {
      console.error('[rollup] could not enqueue:', err.message);
    }
  };
  tick();
  setInterval(tick, config.rollupIntervalMs);
  console.log(`[server] rollup scheduled every ${config.rollupIntervalMs}ms`);
}

const server = app.listen(config.port, () => {
  console.log(`[server] Usage Metering & Billing Engine listening on http://localhost:${config.port}`);
  console.log(`[server] Stripe mode: ${config.stripe.mode}${config.stripe.secretKey ? ' (key configured)' : ' (STRIPE_SECRET_KEY missing)'}`);
  const tenantCount = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
  if (tenantCount === 0) {
    console.log('[server] No tenants found — run `npm run seed` to create plans + demo tenants.');
  }
});

function shutdown() {
  console.log('[server] shutting down');
  server.close(() => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, db, queue };