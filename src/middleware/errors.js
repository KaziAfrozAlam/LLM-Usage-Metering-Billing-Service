const config = require('../config');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message, detail = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || (err.name === 'TypeError' ? 400 : 500);
  const body = {
    error: err.name || 'Error',
    message: err.message || 'Internal server error',
  };
  if (err.detail) body.detail = err.detail;

  if (status >= 500) console.error(`[http] ${status} ${req.method} ${req.originalUrl}:`, err.stack || err);
  res.status(status).json(body);
}

module.exports = { asyncHandler, HttpError, errorHandler };