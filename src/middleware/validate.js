// Boundary validation. All HTTP input is validated here -> clean 4xx (400),
// never a 500, for malformed/malicious body fields.

const { HttpError } = require('./errors');

const STR = 0;
const INT = 1;

function makeValidator(schema, { allowJson = false, requiredFields = null } = {}) {
  const required = requiredFields !== null ? requiredFields : new Set(Object.keys(schema));
  return (req, res, next) => {
    try {
      let body = req.body;
      if (typeof req.body === 'string' && allowJson) {
        try {
          body = JSON.parse(req.body);
        } catch {
          throw new HttpError(400, 'Request body must be valid JSON.');
        }
      }
      if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'Request body must be a JSON object.');
      }
      for (const [field, kind] of Object.entries(schema)) {
        const value = body[field];
        if (value === undefined || value === null) {
          if (required.has(field)) {
            throw new HttpError(400, `Field "${field}" is required.`);
          }
          continue; // optional field not provided
        }
        if (kind === STR && typeof value !== 'string') {
          throw new HttpError(400, `Field "${field}" must be a string.`);
        }
        if (kind === INT && (!Number.isInteger(value) || value < 0)) {
          throw new HttpError(400, `Field "${field}" must be a non-negative integer.`);
        }
      }
      req.validated = body;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { makeValidator, STR, INT };