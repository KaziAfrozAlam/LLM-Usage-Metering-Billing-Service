const config = require('../config');

/**
 * Tiny in-process job queue with retry + backoff and failure handling.
 * Webhook handling and rollups are enqueued here so the HTTP path responds
 * fast and slow work can retry without dropping events.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class JobQueue {
  constructor({ maxAttempts = config.job.maxAttempts, baseBackoffMs = config.job.baseBackoffMs } = {}) {
    this.maxAttempts = maxAttempts;
    this.baseBackoffMs = baseBackoffMs;
    this.handlers = new Map(); // name -> async fn(payload, ctx)
    this.timers = new Map(); // jobId -> timeout
    this.running = 0;
    this.stats = { enqueued: 0, completed: 0, failed: 0, retries: 0 };
    this._onError = null;
  }

  register(name, handler) {
    this.handlers.set(name, handler);
  }

  onError(fn) {
    this._onError = fn;
  }

  enqueue(name, payload) {
    const job = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name,
      payload,
      attempt: 0,
      createdAt: new Date().toISOString(),
    };
    this.stats.enqueued += 1;
    this._dispatch(job);
    return job.id;
  }

  _dispatch(job) {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      this._fail(job, new Error(`No handler registered for job "${job.name}"`));
      return;
    }
    job.attempt += 1;
    this.running += 1;

    Promise.resolve()
      .then(() => handler(job.payload, { attempt: job.attempt, jobId: job.id }))
      .then(() => {
        this.running -= 1;
        this.stats.completed += 1;
      })
      .catch((err) => {
        this.running -= 1;
        if (job.attempt < this.maxAttempts) {
          this.stats.retries += 1;
          const backoff = this.baseBackoffMs * 2 ** (job.attempt - 1);
          if (this._onError) {
            this._onError({ kind: 'retry', job, error: err, delayMs: backoff });
          }
          this.timers.set(job.id, setTimeout(() => this._dispatch(job), backoff));
        } else {
          this._fail(job, err);
        }
      });
  }

  _fail(job, err) {
    this.stats.failed += 1;
    if (this._onError) {
      this._onError({ kind: 'failed', job, error: err });
    } else {
      console.error(`[queue] job "${job.name}" (${job.id}) failed after ${job.attempt} attempt(s):`, err.message);
    }
  }

  getStats() {
    return { ...this.stats, running: this.running, pendingTimers: this.timers.size };
  }

  /** Test/teardown helper. */
  drainNow() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.running === 0) return resolve();
        setTimeout(check, 10);
      };
      check();
    });
  }
}

module.exports = { JobQueue, sleep };