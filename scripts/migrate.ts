import { createEnv, closeEnv } from '../server/env.ts';
import { loadConfig } from '../server/config.ts';

const config = loadConfig();
const env = createEnv(config);
try {
  const tables = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).first<{ n: number }>();
  const applied = await env.DB.prepare('SELECT COUNT(*) AS n FROM schema_migrations').first<{ n: number }>();
  console.log(`Database ready: ${config.dbPath}`);
  console.log(`Tables: ${tables?.n ?? 0}, applied migrations: ${applied?.n ?? 0}`);
} finally {
  closeEnv(env);
}
