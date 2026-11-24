import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

export const REQUIRED_TABLES = [
  'users',
  'channels',
  'channel_members',
  'messages',
  'sessions',
  'login_attempts',
  'schema_migrations',
  'uploaded_files',
  'message_events',
  'realtime_tickets'
];


function tableNames(db: Database) {
  return new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map(
      (row) => String(row.name)
    )
  );
}

function checksum(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function migrate(
  db: Database,
  {
    schemaPath = join(import.meta.dir, 'schema.sql'),
    migrationsDir = join(import.meta.dir, 'migrations')
  } = {}
) {
  const before = tableNames(db);
  const createdFresh = before.size === 0;
  if (createdFresh) {
    db.exec(readFileSync(schemaPath, 'utf8'));
    console.log('[db] schema initialized');
  }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const files = existsSync(migrationsDir)
    ? readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .sort()
    : [];
  const applied = new Set(
    (db.query('SELECT name FROM schema_migrations').all() as any[]).map((row) => String(row.name))
  );

  if (applied.size === 0) {
    // Existing local database created from schema.sql: record the baseline.
    const insert = db.prepare('INSERT OR IGNORE INTO schema_migrations (name, checksum) VALUES (?, ?)');
    for (const file of files) {
      insert.run(file, checksum(readFileSync(join(migrationsDir, file), 'utf8')));
    }
    console.log('[db] baseline migrations recorded');
  } else {
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)').run(
          file,
          checksum(sql)
        );
      })();
      console.log(`[db] migration applied: ${file}`);
    }
  }

  const tables = tableNames(db);
  const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
  if (missing.length) {
    throw new Error(`Database schema is missing tables: ${missing.join(', ')}`);
  }
  const integrity = db.query('PRAGMA integrity_check').get() as any;
  const result = integrity?.integrity_check ?? Object.values(integrity || {})[0];
  if (result !== 'ok') {
    throw new Error(`PRAGMA integrity_check failed: ${JSON.stringify(integrity)}`);
  }
  return { tables: tables.size, migrations: files.length };
}
