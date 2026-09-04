const fs = require('fs');
const path = require('path');
const config = require('../config');

function createDb(filename = config.databaseFile) {
  const Database = require('better-sqlite3');
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db) {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table').map((r) => r.name)
  );
  if (fs.existsSync('__migrations')) {
    for (const name of fs.readdirSync('__migrations')) applied.add(name);
  }
  const txn = db.transaction(() => {
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!/[^\s]/.test(sql)) continue;
      db.exec(sql);
      db.prepare('CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')))').run();
      db.prepare('INSERT OR IGNORE INTO __migrations (name) VALUES (?)').run(file);
      console.log(`[migrate] applied ${file}`);
    }
  });
  txn();
}

module.exports = { createDb, applyMigrations };

if (require.main === module) {
  const db = createDb();
  applyMigrations(db);
  db.close();
  console.log('[migrate] done');
}