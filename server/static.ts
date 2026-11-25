import { existsSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import type { Config } from './config.ts';

function resolveFrontendDist() {
  const candidates = [
    // Normal `bun server/index.ts` from the repository.
    join(import.meta.dir, '..', 'frontend', 'dist'),
    // `bun build --compile --asset frontend/dist ...`
    join(import.meta.dir, 'dist'),
    join(import.meta.dir, 'frontend', 'dist'),
    join(import.meta.dir, '..', 'dist')
  ];
  return normalize(candidates.find((candidate) => existsSync(candidate)) || candidates[0]);
}

const FRONTEND_DIST = resolveFrontendDist();

function fileResponse(path: string) {
  const file = Bun.file(path);
  const response = new Response(file);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'SAMEORIGIN');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set(
    'content-security-policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'self'"
  );
  return response;
}

/**
 * SPA static handler: only frontend/dist is exposed. data/ and secrets are never
 * reachable through this path.
 */
export async function serveAsset(request: Request, _config?: Config) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  const relative = pathname.replace(/^\/+/, '');
  const candidate = normalize(join(FRONTEND_DIST, relative));
  const inside = candidate === FRONTEND_DIST || candidate.startsWith(`${FRONTEND_DIST}${sep}`);
  if (inside && relative && existsSync(candidate)) {
    return fileResponse(candidate);
  }
  const index = join(FRONTEND_DIST, 'index.html');
  if (existsSync(index)) return fileResponse(index);
  return new Response(
    (Bun as any).isStandaloneExecutable
      ? 'Frontend assets are not embedded. Rebuild with --asset frontend/dist.'
      : 'Frontend build not found. Run "bun run build" first.',
    { status: 404 }
  );
}

export function frontendDist() {
  return FRONTEND_DIST;
}
