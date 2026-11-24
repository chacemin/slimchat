import type { SocketData } from './hub.ts';
import { consumeRealtimeTicket } from '../src/realtime-tickets.js';
import { validateSession } from '../src/session.js';
import { extractSessionToken } from '../src/session-cookie.ts';
import { authorizeRoom } from '../src/room-access.js';

function unauthorized(message = 'Unauthorized', status = 401) {
  return new Response(message, { status });
}

function originAllowed(request: Request, env: any) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set(env.CONFIG?.siteOrigins || []);
  try {
    allowed.add(new URL(env.CONFIG?.publicOrigin || request.url).origin);
  } catch {
    // ignore
  }
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    // ignore
  }
  return allowed.has(origin.replace(/\/+$/, ''));
}

async function roomData(env: any, session: any, kind: string, roomId: number) {
  const access = await authorizeRoom(env.DB, session, kind, roomId);
  if (!access.ok) return null;
  return {
    userId: Number(session.userId),
    token: session.token,
    scope: 'room' as const,
    roomKey: `${kind}:${roomId}`,
    roomKind: kind,
    roomId,
    roomName: access.room?.name || '',
    alive: true
  };
}

/**
 * Authenticates a WebSocket upgrade before handing the socket to Bun.
 * All three legacy paths are supported; the ticket path is one-time use.
 */
export async function authenticateUpgrade(
  request: Request,
  env: any
): Promise<{ data: SocketData; session: any } | { response: Response }> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!originAllowed(request, env)) {
    return { response: unauthorized('Origin not allowed', 403) };
  }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return { response: new Response('Expected websocket', { status: 426 }) };
  }

  if (path === '/api/v1/realtime/ws') {
    const redeemed = await consumeRealtimeTicket(env, url.searchParams.get('ticket'));
    if (!redeemed) {
      return { response: unauthorized('实时票据无效或已过期', 401) };
    }
    if (redeemed.scope === 'inbox') {
      return {
        data: {
          userId: Number(redeemed.session.userId),
          token: redeemed.session.token,
          scope: 'inbox',
          alive: true
        },
        session: redeemed.session
      };
    }
    const data = await roomData(env, redeemed.session, redeemed.roomKind, Number(redeemed.roomId));
    if (!data) return { response: unauthorized('无权访问该会话', 403) };
    return { data, session: redeemed.session };
  }

  const token = extractSessionToken(request);
  const auth = token ? await validateSession(env, token) : { ok: false, status: 401 };
  if (!auth.ok) return { response: unauthorized(auth.message || 'Unauthorized', auth.status) };

  if (path === '/api/inbox/ws') {
    return {
      data: {
        userId: Number(auth.session.userId),
        token,
        scope: 'inbox',
        alive: true
      },
      session: auth.session
    };
  }

  const match = /^\/api\/ws\/(public|private|dm)\/(\d+)$/.exec(path);
  if (match) {
    const data = await roomData(env, auth.session, match[1], Number(match[2]));
    if (!data) return { response: unauthorized('无权访问该会话', 403) };
    return { data, session: auth.session };
  }

  return { response: unauthorized('Not Found', 404) };
}

export function isWebSocketPath(path: string) {
  return (
    path === '/api/inbox/ws' ||
    path === '/api/v1/realtime/ws' ||
    /^\/api\/ws\/(public|private|dm)\/\d+$/.test(path)
  );
}
