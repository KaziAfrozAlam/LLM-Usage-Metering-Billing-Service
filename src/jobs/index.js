// Registration of background jobs (queued webhook handling + scheduled rollup).
// Webhooks are processed ASYNC: the HTTP route verifies signature + dedups and
// returns 200 immediately; the job queue processes and retries the handler.

const { JobQueue } = require('./queue');
const { runRollup } = require('./rollup');
const subscriptionService = require('../services/subscriptionService');

function registerJobs(queue, db) {
  queue.register('webhook.process', (payload) => {
    const event = payload.event;
    let result;
    switch (event.type) {
      case 'checkout.session.completed':
        result = subscriptionService.applyCheckoutCompleted(db, event);
        break;
      case 'customer.subscription.updated':
        result = subscriptionService.applySubscriptionUpdated(db, event);
        break;
      case 'customer.subscription.deleted':
        result = subscriptionService.applySubscriptionDeleted(db, event);
        break;
      default:
        result = { applied: false, reason: `unhandled event type ${event.type}` };
    }
    return result;
  });

  queue.register('rollup.run', async () => {
    return runRollup(db);
  });
}

module.exports = { registerJobs };