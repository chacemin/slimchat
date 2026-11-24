import { createHash } from 'node:crypto';
import { statSync, statfsSync } from 'node:fs';
import { loadEncryptionKeyring } from '../encryption.js';
import { getFileStorage, hasFileStorage } from '../storage/index.ts';
import { REQUIRED_TABLES } from '../../db/migrate.ts';

const VERSION = 'v0.1.0';
const MIN_FREE_BYTES = 1024 * 1024 * 1024;

interface MaintenanceEnv {
  DB?: { prepare(sql: string): { all(): Promise<{ results: any[] }> } };
  FILES?: unknown;
  HUB?: { stats(): { connections: number; rooms: number; inboxes: number } };
  CALLS?: { stats?(): { activeCalls: number; activeLeases: number } };
  SCHEDULER?: { stats(): { running: string[]; lastRuns: Record<string, string>; nextGcHour: number } };
  CONFIG?: Record<string, any>;
  ENCRYPTION_KEYRING?: string;
  [key: string]: unknown;
}

type CheckStatus = 'ok' | 'error' | 'missing' | 'disabled' | 'blocked';
interface Check {
  id: string;
  status: CheckStatus;
  code: string;
  durationMs: number;
  details?: Record<string, unknown>;
  schema?: Record<string, unknown>;
}

async function probe(id: string, operation: () => Promise<Partial<Check>>, timeoutMs: number): Promise<Check> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<Partial<Check>>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'error', code: 'timeout' }), timeoutMs);
      })
    ]);
    return { id, status: 'ok', code: 'reachable', ...result, durationMs: Date.now() - started };
  } catch {
    return { id, status: 'error', code: 'request_failed', durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function fileSize(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function diskFree(dataDir: string) {
  try {
    const stats = statfsSync(dataDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function inspectEnvironment(env: MaintenanceEnv) {
  const present = (name: string) => typeof env[name] === 'string' && (env[name] as string).trim().length > 0;
  const cfg = (env.CONFIG || {}) as any;
  return [
    { name: 'data/secrets/keyring.json', required: true, present: present('ENCRYPTION_KEYRING') },
    { name: 'SLIMCHAT_DATA_DIR', required: true, present: Boolean(cfg.dataDir) },
    { name: 'SLIMCHAT_PUBLIC_ORIGIN', required: true, present: Boolean(cfg.publicOrigin) },
    { name: 'SLIMCHAT_SITE_ORIGINS', required: false, present: Array.isArray(cfg.siteOrigins) && cfg.siteOrigins.length > 0 },
    { name: 'SLIMCHAT_LOGIN_GATE_ENABLED', required: false, present: Boolean(cfg.loginGateEnabled) },
    { name: 'SLIMCHAT_TURN_URL', required: false, present: Boolean(cfg.turnUrl) }
  ];
}

export async function runSystemCheck(env: MaintenanceEnv, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  const cfg = (env.CONFIG || {}) as any;
  let schemaInfo: Record<string, unknown> | null = null;
  const runtime: Record<string, unknown> = {
    dataDir: cfg.dataDir || null,
    dbPath: cfg.dbPath || null,
    dbBytes: cfg.dbPath ? fileSize(cfg.dbPath) : null,
    filesDir: cfg.filesDir || null,
    diskFreeBytes: cfg.dataDir ? diskFree(cfg.dataDir) : null,
    tableCount: null,
    fileObjects: null,
    wsConnections: 0,
    wsRooms: 0,
    wsInboxes: 0,
    activeCalls: 0,
    activeLeases: 0,
    keyringActiveKeyId: null,
    keyringKeyCount: 0,
    schedulerTasks: [],
    turnConfigured: Boolean(cfg.turnUrl)
  };

  const database = async (): Promise<Check[]> => {
    if (!env.DB) {
      return [
        { id: 'database', status: 'missing', code: 'not_configured', durationMs: 0 },
        { id: 'schema', status: 'blocked', code: 'database_unavailable', durationMs: 0 }
      ];
    }
    const connectivity = await probe(
      'database',
      async () => {
        await env.DB!.prepare('SELECT 1').all();
        return { details: { path: cfg.dbPath || null, sizeBytes: runtime.dbBytes } };
      },
      timeoutMs
    );
    if (connectivity.status !== 'ok') {
      return [connectivity, { id: 'schema', status: 'blocked', code: 'database_unavailable', durationMs: 0 }];
    }
    const schema = await probe(
      'schema',
      async () => {
        const tables = (await env.DB!.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).all()).results.map((row) => String(row.name));
        const applied = (await env.DB!.prepare(
          'SELECT name FROM schema_migrations ORDER BY name'
        ).all()).results.map((row) => String(row.name));
        const integrityRow = (await env.DB!.prepare('PRAGMA integrity_check').all()).results[0];
        const integrityOk = Object.values(integrityRow || {}).includes('ok');
        const missingArtifacts = REQUIRED_TABLES.filter((table) => !tables.includes(table));
        runtime.tableCount = tables.length;
        schemaInfo = {
          status: integrityOk && missingArtifacts.length === 0 ? 'ok' : 'error',
          ledgerPresent: true,
          appliedMigration: applied.at(-1) || null,
          appliedCount: applied.length,
          expectedCount: applied.length,
          missingArtifacts,
          missingMigrations: [],
          changedMigrations: [],
          unknownMigrations: [],
          schemaHash: createHash('sha256').update(tables.join('\n')).digest('hex').slice(0, 16),
          tables: tables.length
        };
        return {
          status: integrityOk && missingArtifacts.length === 0 ? 'ok' : 'error',
          code: !integrityOk ? 'integrity_failed' : missingArtifacts.length ? 'missing_migrations' : 'ok',
          schema: schemaInfo
        };
      },
      timeoutMs
    );
    return [connectivity, schema];
  };

  const [dbChecks, files, keyring, realtime, calls, scheduler, turn, disk] = await Promise.all([
    database(),
    hasFileStorage(env as any)
      ? probe(
          'files',
          async () => {
            const listed = await (getFileStorage(env as any) as any).list({ limit: 1 });
            let objects = null;
            try {
              const row = (await env.DB!.prepare('SELECT COUNT(*) AS n FROM uploaded_files').all()).results[0];
              objects = Number(row?.n || 0);
            } catch {
              objects = null;
            }
            runtime.fileObjects = objects;
            return {
              details: {
                filesDir: cfg.filesDir || null,
                objectCount: objects,
                sampleAvailable: Array.isArray(listed?.objects) && listed.objects.length > 0
              }
            };
          },
          timeoutMs
        )
      : ({ id: 'files', status: 'missing', code: 'not_configured', durationMs: 0 } as Check),
    probe(
      'keyring',
      async () => {
        const keyring = loadEncryptionKeyring(env);
        runtime.keyringActiveKeyId = keyring.activeKeyId;
        runtime.keyringKeyCount = keyring.keys.size;
        return {
          details: {
            file: cfg.keyringFile || null,
            activeKeyId: keyring.activeKeyId,
            keyCount: keyring.keys.size
          }
        };
      },
      timeoutMs
    ),
    env.HUB
      ? probe(
          'hub',
          async () => {
            const stats = env.HUB!.stats();
            runtime.wsConnections = stats.connections;
            runtime.wsRooms = stats.rooms;
            runtime.wsInboxes = stats.inboxes;
            return { details: stats };
          },
          timeoutMs
        )
      : ({ id: 'hub', status: 'missing', code: 'not_configured', durationMs: 0 } as Check),
    env.CALLS
      ? probe(
          'calls',
          async () => {
            const stats = env.CALLS!.stats?.() || { activeCalls: 0, activeLeases: 0 };
            runtime.activeCalls = stats.activeCalls;
            runtime.activeLeases = stats.activeLeases;
            return { details: stats };
          },
          timeoutMs
        )
      : ({ id: 'calls', status: 'disabled', code: 'not_enabled', durationMs: 0 } as Check),
    env.SCHEDULER
      ? probe(
          'scheduler',
          async () => {
            const stats = env.SCHEDULER!.stats();
            runtime.schedulerTasks = [...stats.running];
            return { details: stats };
          },
          timeoutMs
        )
      : ({ id: 'scheduler', status: 'disabled', code: 'not_enabled', durationMs: 0 } as Check),
    Promise.resolve(
      cfg.turnUrl && (cfg.turnSharedSecret || (cfg.turnUsername && cfg.turnCredential))
        ? ({
            id: 'turn',
            status: 'ok',
            code: 'configured',
            durationMs: 0,
            details: { url: cfg.turnUrl }
          } as Check)
        : ({
            id: 'turn',
            status: 'disabled',
            code: 'not_enabled',
            durationMs: 0,
            details: { url: null }
          } as Check)
    ),
    Promise.resolve(
      (() => {
        const freeBytes = cfg.dataDir ? diskFree(cfg.dataDir) : null;
        runtime.diskFreeBytes = freeBytes;
        if (freeBytes === null) {
          return { id: 'disk', status: 'error', code: 'request_failed', durationMs: 0 } as Check;
        }
        return {
          id: 'disk',
          status: freeBytes >= MIN_FREE_BYTES ? 'ok' : 'error',
          code: freeBytes >= MIN_FREE_BYTES ? 'ok' : 'disk_low',
          durationMs: 0,
          details: { freeBytes, minFreeBytes: MIN_FREE_BYTES }
        } as Check;
      })()
    )
  ]);

  const environment = inspectEnvironment(env);
  const checks: Check[] = [
    ...dbChecks,
    files,
    keyring,
    realtime,
    calls,
    scheduler,
    turn,
    disk,
    {
      id: 'environment',
      status: environment.some((item) => item.required && !item.present) ? 'missing' : 'ok',
      code: 'presence_only',
      durationMs: 0
    }
  ];

  return {
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    status: checks.some((check) => ['error', 'missing', 'blocked'].includes(check.status))
      ? 'error'
      : checks.some((check) => check.status === 'disabled')
        ? 'warning'
        : 'ok',
    version: VERSION,
    expectedMigration: schemaInfo?.appliedMigration ?? null,
    runtime,
    checks,
    environment
  };
}
