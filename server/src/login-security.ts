import { ApiError } from './errors.js';
import { extractSessionToken } from './session-cookie.ts';

export function clientIp(request: Request, trustProxy = false) {
  if (trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for') || '';
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
    const real = request.headers.get('x-real-ip');
    if (real) return real.trim();
  }
  return 'local';
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(String(left || ''));
  const b = new TextEncoder().encode(String(right || ''));
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/** Per-session API sliding window (falls back to client IP for unauthenticated calls). */
export async function enforceRateLimit(env, request: Request) {
  if (!env.RATE_LIMITER?.apiLimit) return;
  const token = extractSessionToken(request);
  const key = token ? `session:${token.slice(0, 16)}` : `ip:${clientIp(request, env.CONFIG?.trustProxy)}`;
  await env.RATE_LIMITER.apiLimit(key, env.CONFIG?.apiLimit);
}

/**
 * Local access gate. The optional gate is a password from
 * .env, never a network challenge, and all attempts are rate limited + logged.
 */
export async function verifyLoginSecurity(env, request: Request, payload: any = {}) {
  const ip = clientIp(request, env.CONFIG?.trustProxy);
  await env.RATE_LIMITER?.loginLimit?.(ip, payload?.username);

  const gateEnabled = Boolean(env.CONFIG?.loginGateEnabled);
  if (!gateEnabled) return;

  const expected = env.CONFIG?.loginGatePassword || '';
  const provided = String(payload?.loginGate || '');
  if (!expected) {
    throw new ApiError('访问口令尚未配置，请联系管理员', 503, 'gate_unavailable');
  }
  // Changing the configured password invalidates every stale client immediately.
  if (!constantTimeEqual(provided, expected)) {
    await env.RATE_LIMITER?.recordLoginFailure?.(ip, payload?.username);
    throw new ApiError('访问口令不正确', 401, 'gate_required');
  }
}

export async function recordLoginFailure(env, request: Request, username: string) {
  await env.RATE_LIMITER?.recordLoginFailure?.(
    clientIp(request, env.CONFIG?.trustProxy),
    String(username || '')
  );
}
