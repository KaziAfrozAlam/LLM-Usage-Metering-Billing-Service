const db = require('better-sqlite3')('dev.db');
db.prepare(
  "INSERT INTO tenants (id,name,api_key,plan_id,status) VALUES ('boundary','Boundary Test','key_boundary','free','active') ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key, plan_id=excluded.plan_id"
).run();
db.prepare("DELETE FROM usage_events WHERE tenant_id='boundary'").run();
const ins = db.prepare('INSERT INTO usage_events (tenant_id,type,quantity,idempotency_key) VALUES (?,?,?,?)');
const tx = db.transaction(() => { for (let i = 0; i < 999; i++) ins.run('boundary', 'api_call', 1, 'bound_' + i); });
tx();
console.log('boundary tenant now at 999/1000 api calls');