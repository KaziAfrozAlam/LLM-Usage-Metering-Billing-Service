const express = require('express');
const { errorHandler } = require('./middleware/errors');
const generateRouter = require('./routes/generate');
const usageRouter = require('./routes/usage');
const checkoutRouter = require('./routes/checkout');
const webhooksRouter = require('./routes/webhooks');
const { getPlan } = require('./services/repo');

/**
 * App factory. `db` is a better-sqlite3 connection; `queue` is a JobQueue.
 * Both can be injected for tests (in-memory db, draining queue).
 */
function createApp(db, queue) {
  const app = express();

  app.disable('x-powered-by');

  // Webhook needs the RAW body for signature verification.
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

  // JSON body parsing for the API (boundary validation strips bad input).
  app.use(express.json({ strict: true }));

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'usage-metering-billing-engine', time: new Date().toISOString() });
  });

  app.get('/plans', (req, res) => {
    const plans = ['free', 'pro'].map((id) => getPlan(db, id)).filter(Boolean);
    res.json({ plans });
  });

  app.use('/generate', generateRouter(db));
  app.use('/usage', usageRouter(db));
  app.use('/checkout', checkoutRouter(db));
  app.use('/webhooks/stripe', webhooksRouter(db, queue));

  app.use((req, res) => {
    res.status(404).json({ error: 'NotFound', message: `No route for ${req.method} ${req.originalUrl}` });
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };