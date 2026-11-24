import { runAuthorizedBatch } from '../rbac/authorization.ts';
import { ApiError } from '../errors.js';
import { summarizeR2Objects } from '../storage-statistics.js';
import { listStorageOwners } from '../data/users.js';
import { getFileStorage } from '../storage/index.ts';

// Paged scan state is process-local; a restart only asks the admin to scan again.
const scanStates = new Map<string, { userId: number; state: any }>();

export function registerStorageRoutes(app) {
  app.get('/api/admin/storage', async (c) => {
    const row = await c.env.DB.prepare("SELECT setting_value FROM site_settings WHERE setting_key = 'admin_storage_snapshot'").first();
    return c.json(row ? JSON.parse(row.setting_value) : { items: [], users: [], scannedAt: null });
  });
  app.post('/api/admin/storage/scan', async (c) => {
    const storage = getFileStorage(c.env);
    if (!storage) throw new ApiError('本地文件存储不可用', 503);
    const userId = c.get('session').userId;
    const cursor = c.req.query('cursor') || '';
    const stored = cursor ? scanStates.get(cursor) : null;
    let state = stored?.userId === userId ? stored.state : null;
    if (cursor && (!state || state.pages >= 100)) throw new ApiError('扫描游标无效或超过单次扫描范围', 400);
    const db = c.get('authorizationDatabase');
    if (!cursor) {
      await runAuthorizedBatch(db, c.get('authorizationContext'), [], {
        sql: "NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE actor_id = ? AND action = 'storage.scan' AND created_at > datetime('now', '-1 minute'))",
        params: [c.get('session').userId],
      });
      state = { pages: 0, items: {}, users: await listStorageOwners(db) };
    }
    const listed = await storage.list({ limit: 1000, ...(cursor ? { cursor } : {}), include: [] });
    const items = summarizeR2Objects(listed.objects);
    for (const item of items) {
      const previous = state.items[item.ownerKey];
      state.items[item.ownerKey] = previous ? { ...item, bytes: previous.bytes + item.bytes,
        objectCount: previous.objectCount + item.objectCount, latestUploadedAt: [previous.latestUploadedAt, item.latestUploadedAt].filter(Boolean).sort().pop() || null } : item;
    }
    state.pages++;
    state.cursor = listed.truncated ? listed.cursor : null;
    let nextCursor = cursor;
    if (listed.truncated) {
      if (!nextCursor) nextCursor = crypto.randomUUID();
      state.cursor = listed.cursor;
      scanStates.set(nextCursor, { userId, state });
    } else {
      const snapshot = { items: Object.values(state.items), users: state.users, scannedAt: new Date().toISOString() };
      await runAuthorizedBatch(db, c.get('authorizationContext'), [db.prepare(`INSERT INTO site_settings (setting_key, setting_value)
        VALUES ('admin_storage_snapshot', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`).bind(JSON.stringify(snapshot))]);
      if (cursor) scanStates.delete(cursor);
    }
    return c.json({ items, users: cursor ? undefined : state.users, scannedObjects: listed.objects.length, truncated: listed.truncated, cursor: listed.truncated ? nextCursor : null });
  });
}
