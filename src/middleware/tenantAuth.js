const { loadTenantWithPlan } = require('../services/repo');

/**
 * Tenant isolation middleware: requires an API key in the X-API-Key header.
 * The tenant is loaded (with plan + subscription status) and attached to req.
 * Every handler is then scoped to req.tenant — tenant data can never leak
 * across tenants because each request is bound to exactly one tenant.
 */
function tenantAuth(db) {
  return (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Missing X-API-Key header.' });
    }
    const tenantRow = db.prepare('SELECT id FROM tenants WHERE api_key = ?').get(apiKey);
    if (!tenantRow) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Unknown API key.' });
    }
    const tenant = loadTenantWithPlan(db, tenantRow.id);
    if (tenant.status === 'suspended') {
      return res.status(403).json({ error: 'Forbidden', message: `Tenant "${tenant.id}" is suspended.` });
    }
    req.tenant = tenant;
    next();
  };
}

module.exports = { tenantAuth };