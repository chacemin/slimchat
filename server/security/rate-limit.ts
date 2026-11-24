import { ApiError } from '../src/errors.js';

const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

/**
 * In-process sliding window, plus a SQLite login_attempts ledger so a restart
 * cannot be used to bypass brute-force protection.
 */
export class RateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private db: { prepare(sql: string): any },
    private cfg: { loginLimit?: number; apiLimit?: number }
  ) {}

  private sweep(key: string) {
    const now = Date.now();
    const hits = (this.windows.get(key) || []).filter((at) => now - at < WINDOW_MS);
    if (hits.length === 0) this.windows.delete(key);
    else this.windows.set(key, hits);
    if (this.windows.size > MAX_KEYS) {
      const oldest = this.windows.keys().next().value;
      if (oldest) this.windows.delete(oldest);
    }
    return hits;
  }

  async apiLimit(key: string, limit = this.cfg.apiLimit || 120) {
    const hits = this.sweep(`api:${key}`);
    if (hits.length >= limit) {
      throw new ApiError('请求过于频繁，请稍后重试', 429, 'rate_limited');
    }
    hits.push(Date.now());
    if (!this.windows.has(`api:${key}`)) this.windows.set(`api:${key}`, hits);
  }

  async loginLimit(ip: string, username: string, limit = this.cfg.loginLimit || 10) {
    const now = Date.now();
    const hits = this.sweep(`login:${ip}`);
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM login_attempts WHERE scope_key = ? AND attempted_at > ?'
      )
      .bind(`${ip}|${String(username || '').toLowerCase()}`, now - WINDOW_MS)
      .first<{ n: number }>();
    if (hits.length + Number(row?.n || 0) >= limit) {
      throw new ApiError('尝试次数过多，请稍后再试', 429, 'rate_limited');
    }
    hits.push(now);
    if (!this.windows.has(`login:${ip}`)) this.windows.set(`login:${ip}`, hits);
  }

  async recordLoginFailure(ip: string, username: string) {
    await this.db
      .prepare('INSERT INTO login_attempts (scope_key, attempted_at) VALUES (?, ?)')
      .bind(`${ip}|${String(username || '').toLowerCase()}`, Date.now())
      .run();
  }

  async pruneLoginAttempts(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    await this.db
      .prepare('DELETE FROM login_attempts WHERE attempted_at < ?')
      .bind(Date.now() - maxAgeMs)
      .run();
    this.windows.clear();
  }
}
