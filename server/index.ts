import { closeEnv, createEnv } from './env.ts';
import { loadConfig } from './config.ts';
import { runCli } from './cli.ts';
import { bootstrapAdmin } from './bootstrap.ts';
import { databaseHasUserData, hasKeyring, initKeyring } from './security/keyring.ts';
import { startScheduler } from './scheduler.ts';
import { authenticateUpgrade, isWebSocketPath } from './realtime/upgrade.ts';
import { siteFetch } from './src/app.js';
import type { Client } from './realtime/hub.ts';

function cliArgs() {
  // Bun argv is [runtime, script-or-virtual-entry, ...args] in both dev and
  // compiled executables, so the first user argument is always at index 2.
  return process.argv.slice(2);
}

async function main() {
  const config = loadConfig();

  if (await runCli(cliArgs(), config)) {
    process.exit(process.exitCode ?? 0);
  }

  if (!hasKeyring(config)) {
    if (databaseHasUserData(config)) {
      throw new Error(
        `Database ${config.dbPath} contains users or messages, but no keyring exists at ${config.keyringFile}. ` +
          'Restore data/secrets/keyring.json from backup before starting SlimChat.'
      );
    }
    const created = initKeyring(config);
    if (created.created) {
      console.warn(`[security] Keyring created: ${created.path}`);
      console.warn('[security] Back up data/secrets/keyring.json; losing it makes data unreadable.');
    }
  }

  const env = createEnv(config);
  if (process.env.SLIMCHAT_ADMIN_PASSWORD) {
    const admin = await bootstrapAdmin(env, config);
    if (admin.status === 'created') {
      console.log(`Super administrator created: ${admin.username} (id ${admin.userId})`);
    }
  }

  const scheduler = startScheduler(env);
  env.SCHEDULER = scheduler;

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: async (request, bunServer) => {
      const path = new URL(request.url).pathname;
      if (isWebSocketPath(path)) {
        const auth = await authenticateUpgrade(request, env);
        if ('response' in auth) return auth.response;
        const upgraded = bunServer.upgrade(request, { data: auth.data });
        if (!upgraded) return new Response('Upgrade failed', { status: 400 });
        return undefined;
      }
      return siteFetch(request, env, { waitUntil: (promise: Promise<unknown>) => void promise });
    },
    websocket: {
      open(ws: Client) {
        env.HUB.join(ws);
      },
      message(ws: Client, message: string | Buffer) {
        void env.HUB.onMessage(env, ws, message);
      },
      close(ws: Client) {
        env.HUB.leave(ws);
      },
      pong(ws: Client) {
        ws.data.alive = true;
      },
      drain(ws: Client) {
        // Backpressure recovered; no buffered queue is kept on purpose.
        void ws;
      }
    },
    error(error) {
      console.error('[server]', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  });

  console.log(`SlimChat listening on http://${config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  if (config.standalone) console.log('Running as a standalone executable.');
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn(
      '[security] Listening on a non-loopback address. Enable SLIMCHAT_LOGIN_GATE_ENABLED and use a reverse proxy with HTTPS for LAN access.'
    );
  }

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    scheduler.stop();
    try {
      server.stop(true);
    } catch {
      // ignore
    }
    closeEnv(env);
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
