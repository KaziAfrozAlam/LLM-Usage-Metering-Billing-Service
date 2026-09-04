const { Router } = require('express');
const config = require('../config');

/**
 * POST /webhooks/stripe
 * Stripe (TEST MODE) signed webhook endpoint.
 * Order of operations:
 *   1. Verify 'stripe-signature' over the RAW body. Forged/garbled -> 400.
 *   2. Deduplicate by event id (replayed events -> ignored, once).
 *   3. Enqueue the event for ASYNC processing (JobQueue with retry/backoff).
 *   4. Respond 200 quickly; the handler updates tenant plan/status.
 */
module.exports = function webhooksRouter(db, queue) {
  const router = Router();

  router.post('/', (req, res) => {
    const signature = req.headers['stripe-signature'];
    const secret = config.stripe.webhookSecret;

    if (!signature) {
      return res.status(400).json({ error: 'BadRequest', message: 'Missing Stripe-Signature header.' });
    }
    if (!secret) {
      return res
        .status(503)
        .json({ error: 'NotConfigured', message: 'STRIPE_WEBHOOK_SECRET is not set. Set it (from `stripe listen`) and restart.' });
    }

    let event;
    try {
      const Stripe = require('stripe');
      const stripe = new Stripe(config.stripe.secretKey || 'sk_test_none');
      event = stripe.webhooks.constructEvent(req.body, signature, secret);
    } catch (err) {
      return res.status(400).json({ error: 'SignatureVerificationFailed', message: `Webhook signature verification failed: ${err.message}` });
    }

    // Dedup: the event id is the primary key. A replayed event is skipped.
    const already = db.prepare('SELECT id FROM stripe_events WHERE id = ?').get(event.id);
    if (already) {
      return res.status(200).json({ received: true, event_id: event.id, type: event.type, processed: false, duplicate: true });
    }
    db.prepare('INSERT INTO stripe_events (id, type) VALUES (?, ?)').run(event.id, event.type);

    // ASYNC processing with retry: response returns immediately.
    queue.enqueue('webhook.process', { event });

    return res.status(200).json({ received: true, event_id: event.id, type: event.type, processed: true, async: true });
  });

  return router;
};