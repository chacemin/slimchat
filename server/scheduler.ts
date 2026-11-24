import type { Env } from './env.ts';
import { runScheduledGc } from './src/gc.js';

export interface SchedulerHandle {
  stop(): void;
  stats(): {
    running: string[];
    lastRuns: Record<string, string>;
    nextGcHour: number;
  };
}

/**
 * Single in-process scheduler replacing Cron Triggers and the SCHEDULER DO.
 * Each task is guarded so the same task cannot overlap itself.
 */
export function startScheduler(env: Env): SchedulerHandle {
  const running = new Set<string>();
  const lastRuns: Record<string, string> = {};
  let lastGcDay = '';

  const every = (name: string, intervalMs: number, task: () => Promise<unknown>) => {
    const tick = () => {
      if (running.has(name)) return;
      running.add(name);
      void task()
        .catch((error) => console.error(`[scheduler] ${name} failed`, error))
        .finally(() => {
          running.delete(name);
          lastRuns[name] = new Date().toISOString();
        });
    };
    setTimeout(tick, Math.min(intervalMs, 10_000));
    return setInterval(tick, intervalMs);
  };

  const timers = [
    every('prune', 60 * 60 * 1000, async () => {
      await env.SESSIONS.pruneExpired();
      await env.DB.prepare(
        "DELETE FROM realtime_tickets WHERE expires_at <= CURRENT_TIMESTAMP OR (consumed_at IS NOT NULL AND consumed_at < datetime('now', '-1 day'))"
      ).run();
      await env.RATE_LIMITER.pruneLoginAttempts();
      await env.DB.prepare('DELETE FROM device_sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
    }),
    every('heartbeat', 30 * 1000, async () => {
      await env.HUB.heartbeat(env);
      await env.CALLS.sweep(env);
    }),
    every('checkpoint', 6 * 60 * 60 * 1000, async () => {
      env._sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }),
    every('files', 24 * 60 * 60 * 1000, async () => {
      await env.FILES.cleanupTemp();
    }),
    every('analyze', 7 * 24 * 60 * 60 * 1000, async () => {
      env._sqlite.exec('ANALYZE');
    }),
    every('gc', 5 * 60 * 1000, async () => {
      const now = new Date();
      const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
      if (now.getHours() < env.CONFIG.gcCronHour || lastGcDay === day) return;
      lastGcDay = day;
      await runScheduledGc(env);
    })
  ];

  return {
    stop() {
      for (const timer of timers) clearInterval(timer);
    },
    stats() {
      return {
        running: [...running],
        lastRuns: { ...lastRuns },
        nextGcHour: env.CONFIG.gcCronHour
      };
    }
  };
}
