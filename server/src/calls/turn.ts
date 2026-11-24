import { CALL_STUN } from '../../../shared/voice-call.ts';
import { createHmac } from 'node:crypto';

export function turnConfigured(env: any): boolean {
  const cfg = env.CONFIG || {};
  return Boolean(cfg.turnUrl && (cfg.turnSharedSecret || (cfg.turnUsername && cfg.turnCredential)));
}

/**
 * Local coturn credentials. Nothing leaves the machine: either static
 * SLIMCHAT_TURN_* values or short-lived credentials derived from a shared secret.
 */
export async function generateCallIceServers(env: any) {
  const cfg = env.CONFIG || {};
  const iceServers: Array<{ urls: string; username?: string; credential?: string }> = [
    ...CALL_STUN
  ];
  if (!turnConfigured(env)) return { iceServers };

  let username = cfg.turnUsername || '';
  let credential = cfg.turnCredential || '';
  if (cfg.turnSharedSecret) {
    const ttl = 3600;
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    username = `${expiry}:slimchat`;
    credential = createHmac('sha1', cfg.turnSharedSecret).update(username).digest('base64');
  }
  const urls = String(cfg.turnUrl || '')
    .split(',')
    .map((value: string) => value.trim())
    .filter(Boolean);
  for (const url of urls) {
    iceServers.push({ urls: url, username, credential });
  }
  return { iceServers };
}
