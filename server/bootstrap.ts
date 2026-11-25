import { hashPassword } from './src/auth.js';
import { ensureGeneralChannelMembership } from './src/data/general-channel.js';
import { isValidNewUsername, USERNAME_RULE_ERROR } from '../shared/username.ts';
import type { Config } from './config.ts';

export interface BootstrapAdminResult {
  status: 'created' | 'exists' | 'skipped';
  userId?: number;
  username?: string;
}

/**
 * Creates the first super administrator. Existing usernames are never modified,
 * so it is safe to call on every startup when SLIMCHAT_ADMIN_PASSWORD is set.
 */
export async function bootstrapAdmin(
  env: { DB: { prepare(sql: string): any } },
  config: Config,
  credentials: { username?: string; password?: string; displayName?: string } = {}
): Promise<BootstrapAdminResult> {
  const username = String(
    credentials.username ?? process.env.SLIMCHAT_ADMIN_USERNAME ?? config.adminUsername ?? ''
  ).trim();
  const password = String(credentials.password ?? process.env.SLIMCHAT_ADMIN_PASSWORD ?? '');
  const displayName = String(
    credentials.displayName ??
      process.env.SLIMCHAT_ADMIN_DISPLAY_NAME ??
      config.adminDisplayName ??
      username
  ).trim();

  if (!username || !password) return { status: 'skipped' };
  if (!isValidNewUsername(username)) throw new Error(USERNAME_RULE_ERROR);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: number }>();
  if (existing?.id) {
    return { status: 'exists', userId: Number(existing.id), username };
  }

  const hashed = await hashPassword(password);
  const result = await env.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, password_salt,
       is_admin, is_super_admin, management_protected)
     VALUES (?, ?, ?, ?, 1, 1, 1)`
  )
    .bind(username, displayName || username, hashed.hash, hashed.salt)
    .run();
  const userId = Number(result.meta.last_row_id);
  await env.DB.prepare('INSERT OR REPLACE INTO rbac_user_roles (user_id, role_id) VALUES (?, 1)')
    .bind(userId)
    .run();
  await ensureGeneralChannelMembership(env.DB as any, userId);
  return { status: 'created', userId, username };
}
