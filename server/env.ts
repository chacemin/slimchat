import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { D1Compat } from './db/d1-compat.ts';
import { migrate } from './db/migrate.ts';
import { loadConfig, type Config } from './config.ts';
import { SessionStore } from './security/session-store.ts';
import { RateLimiter } from './security/rate-limit.ts';
import { LocalFileStore } from './storage/local-files.ts';
import { RealtimeHub } from './realtime/hub.ts';
import { CallService } from './calls/service.ts';
import { serveAsset } from './static.ts';

export interface Env {
  DB: D1Compat;
  SESSIONS: SessionStore;
  FILES: LocalFileStore;
  HUB: RealtimeHub;
  RATE_LIMITER: RateLimiter;
  CALLS: CallService;
  CONFIG: Config;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ENCRYPTION_KEYRING: string;
  SCHEDULER?: {
    stats(): { running: string[]; lastRuns: Record<string, string>; nextGcHour: number };
  };
  _sqlite: Database;
  [key: string]: unknown;
}

function readKeyring(path: string) {
  if (!existsSync(path)) {
    console.warn(
      `[security] keyring not found at ${path}. Run "bun run keyring:init" before first use.`
    );
    return '';
  }
  return readFileSync(path, 'utf8');
}

export function createEnv(config: Config = loadConfig()): Env {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.filesDir, { recursive: true });
  mkdirSync(config.logDir, { recursive: true });
  mkdirSync(dirname(config.keyringFile), { recursive: true, mode: 0o700 });

  const sqlite = new Database(config.dbPath, { create: true });
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -16000;
    PRAGMA wal_autocheckpoint = 1000;
  `);

  const DB = new D1Compat(sqlite);
  migrate(sqlite);

  const HUB = new RealtimeHub();
  const env = {
    DB,
    SESSIONS: new SessionStore(DB, config.sessionTtlDays),
    FILES: new LocalFileStore(config.filesDir),
    HUB,
    RATE_LIMITER: new RateLimiter(DB, config),
    CALLS: new CallService(),
    CONFIG: config,
    ENCRYPTION_KEYRING: readKeyring(config.keyringFile),
    ...config.vars,
    _sqlite: sqlite,
    ASSETS: {
      fetch(request: Request) {
        return serveAsset(request, config);
      }
    }
  } as Env;
  // Legacy modules read c.env.MAX_FILE_SIZE etc. and c.env.SESSIONS/FILES directly.
  return env;
}

export function closeEnv(env: Env) {
  try {
    env._sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // best effort
  }
  env._sqlite.close();
}
