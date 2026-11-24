import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Hono } from 'hono';
import initSqlJs from 'sql.js';
import { registerMaintenanceRoutes } from '../server/src/api/maintenance.ts';
import { inspectEnvironment, runSystemCheck } from '../server/src/maintenance/system-check.ts';
import { authMiddleware, adminMiddleware } from '../server/src/middleware.js';
import { createD1Adapter } from './support/d1.js';

const okDb = {
  prepare(sql) {
    return {
      all: async () => ({
        results: sql.includes('integrity_check')
          ? [{ integrity_check: 'ok' }]
          : sql.includes('schema_migrations')
            ? [{ name: '0001-baseline.sql' }]
            : sql.includes('sqlite_master')
              ? [{ name: 'users' }]
              : sql.includes('COUNT(*)')
                ? [{ n: 0 }]
                : [{ ok: 1 }]
      })
    };
  }
};

const keyring = JSON.stringify({
  activeKeyId: 'test',
  keys: { test: Buffer.alloc(32, 7).toString('base64') }
});

const config = {
  dataDir: '/tmp',
  dbPath: '/tmp/slimchat-maintenance-test.db',
  filesDir: '/tmp/slimchat-maintenance-files',
  keyringFile: '/tmp/slimchat-maintenance-keyring.json',
  publicOrigin: 'http://127.0.0.1:8787',
  siteOrigins: ['http://127.0.0.1:8787'],
  loginGateEnabled: false,
  turnUrl: ''
};

test('environment exposes presence only, never secret values', () => {
  const result = inspectEnvironment({ ENCRYPTION_KEYRING: 'super-secret', CONFIG: config });
  assert.equal(JSON.stringify(result).includes('super-secret'), false);
  assert.equal(result.find((item) => item.name.includes('keyring')).present, true);
});

test('system check isolates failures and optional local services', async () => {
  const result = await runSystemCheck({ DB: okDb, CONFIG: config }, { timeoutMs: 10 });
  assert.equal(result.checks.find((item) => item.id === 'files').status, 'missing');
  assert.equal(result.checks.find((item) => item.id === 'hub').status, 'missing');
  assert.equal(result.checks.find((item) => item.id === 'keyring').status, 'error');
  assert.equal(JSON.stringify(result).includes('super-secret'), false);
});

test('system check reports the local runtime surface', async () => {
  const result = await runSystemCheck(
    {
      DB: okDb,
      ENCRYPTION_KEYRING: keyring,
      FILES: { list: async () => ({ objects: [], truncated: false }) },
      HUB: { stats: () => ({ connections: 2, rooms: 1, inboxes: 1 }) },
      CALLS: { stats: () => ({ activeCalls: 0, activeLeases: 0 }) },
      SCHEDULER: { stats: () => ({ running: [], lastRuns: {}, nextGcHour: 3 }) },
      CONFIG: config
    },
    { timeoutMs: 10 }
  );
  for (const id of ['database', 'files', 'keyring', 'hub', 'calls', 'scheduler', 'disk', 'environment']) {
    assert.notEqual(result.checks.find((item) => item.id === id)?.status, 'missing', id);
  }
  assert.equal(result.checks.find((item) => item.id === 'hub').details.connections, 2);
  assert.equal(result.checks.find((item) => item.id === 'keyring').details.activeKeyId, 'test');
  assert.equal(result.runtime.wsConnections, 2);
  assert.equal(result.runtime.keyringActiveKeyId, 'test');
  assert.equal(result.checks.find((item) => item.id === 'turn').status, 'disabled');
});

test('real auth and admin middleware return 401, 403, and allow admins', async () => {
  const app = new Hono();
  app.onError((error) => Response.json({ error: error.status ? error.message : '服务器开小差了' }, { status: error.status || 500 }));
  app.use('/api/admin/*', authMiddleware, adminMiddleware);
  registerMaintenanceRoutes(app);

  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  database.run("INSERT INTO users (username, display_name, password_hash, password_salt) VALUES ('u', 'u', 'hash', 'salt')");
  const db = createD1Adapter(database);
  const env = { DB: db, SESSIONS: { get: async () => null } };
  assert.equal((await app.request('/api/admin/maintenance', {}, env)).status, 401);

  const session = { userId: 1, isAdmin: false, sessionVersion: 0 };
  const authorizedEnv = { ...env, SESSIONS: { get: async () => JSON.stringify(session), put: async () => {}, delete: async () => {} } };
  assert.equal((await app.request('/api/admin/maintenance', { headers: { Authorization: 'Bearer token' } }, authorizedEnv)).status, 403);

  database.run('UPDATE users SET is_super_admin = 1 WHERE id = 1');
  database.run("UPDATE rbac_user_roles SET role_id = 1 WHERE user_id = 1");
  const adminEnv = {
    ...env,
    SESSIONS: { get: async () => JSON.stringify({ ...session, isAdmin: true }), put: async () => {}, delete: async () => {} }
  };
  const response = await app.request('/api/admin/maintenance', { headers: { Authorization: 'Bearer token' } }, adminEnv);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const report = await response.json();
  assert.equal(report.checks.length, 10);
  assert.ok(report.runtime);
});
