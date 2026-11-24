import { createHash } from 'node:crypto';
import type { D1Compat } from '../db/d1-compat.ts';

type CacheEntry = { value: string; expireAt: number };

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;

function sqlTimestamp(ms: number) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Replaces the KV SESSIONS binding. Tokens are stored only as SHA-256 hashes;
 * a short in-process LRU absorbs repeated reads during one request burst.
 */
export class SessionStore {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private db: D1Compat,
    private defaultTtlDays = 30
  ) {}

  private hash(token: string) {
    return createHash('sha256').update(String(token)).digest('hex');
  }

  private remember(token: string, value: string) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(token, { value, expireAt: Date.now() + CACHE_TTL_MS });
  }

  async put(token: string, value: string, opts: { expirationTtl?: number } = {}) {
    const ttl = Math.max(1, Number(opts.expirationTtl) || this.defaultTtlDays * 86400);
    const expiresAt = sqlTimestamp(Date.now() + ttl * 1000);
    let userId = 0;
    try {
      userId = Number(JSON.parse(value)?.userId) || 0;
    } catch {
      userId = 0;
    }
    if (!userId) throw new Error('Session payload must include userId');
    await this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, payload, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET
           user_id = excluded.user_id,
           payload = excluded.payload,
           expires_at = excluded.expires_at,
           last_seen_at = CURRENT_TIMESTAMP`
      )
      .bind(this.hash(token), userId, value, expiresAt)
      .run();
    this.remember(token, value);
  }

  async get(token: string): Promise<string | null> {
    if (!token) return null;
    const hit = this.cache.get(token);
    if (hit && hit.expireAt > Date.now()) return hit.value;
    const row = await this.db
      .prepare(
        `SELECT payload FROM sessions
         WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP`
      )
      .bind(this.hash(token))
      .first<{ payload: string }>();
    if (!row) {
      this.cache.delete(token);
      return null;
    }
    this.remember(token, row.payload);
    return row.payload;
  }

  async delete(token: string) {
    if (!token) return;
    this.cache.delete(token);
    await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(this.hash(token)).run();
  }

  async deleteByUser(userId: number) {
    this.cache.clear();
    await this.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(Number(userId)).run();
  }

  async pruneExpired() {
    this.cache.clear();
    await this.db.prepare('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
  }
}
