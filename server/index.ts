import { createEnv } from './env.ts';
import { closeEnv } from './env.ts';
import { startScheduler } from './scheduler.ts';
import { authenticateUpgrade, isWebSocketPath } from './realtime/upgrade.ts';
import { siteFetch } from './src/app.js';
import type { Client } from './realtime/hub.ts';

const env = createEnv();
const scheduler = startScheduler(env);
env.SCHEDULER = scheduler;

const server = Bun.serve({
  hostname: env.CONFIG.host,
  port: env.CONFIG.port,
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

console.log(`SlimChat listening on http://${env.CONFIG.host}:${env.CONFIG.port}`);
if (env.CONFIG.host !== '127.0.0.1' && env.CONFIG.host !== 'localhost') {
  console.warn(
    '[security] Listening on a non-loopback address. Enable SLIMCHAT_LOGIN_GATE_ENABLED and use a reverse proxy with HTTPS for LAN access.'
  );
}
if (!env.ENCRYPTION_KEYRING) {
  console.warn('[security] No keyring loaded. Run "bun run keyring:init" before creating users or messages.');
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
