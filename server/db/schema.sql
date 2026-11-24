PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  avatar_key TEXT,
  registration_invite_id INTEGER UNIQUE,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  disabled_until TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_super_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_super_admin IN (0, 1)),
  management_protected INTEGER NOT NULL DEFAULT 0 CHECK(management_protected IN (0, 1)),
  authz_version INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS rbac_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO rbac_roles (id, key, name) VALUES (1, 'ordinary', '普通用户');
CREATE TABLE IF NOT EXISTS rbac_role_permissions (
  role_id INTEGER NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY(role_id, permission_key)
);
CREATE TABLE IF NOT EXISTS rbac_user_roles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL DEFAULT 1 REFERENCES rbac_roles(id) ON DELETE RESTRICT,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rbac_members ON rbac_user_roles(role_id, user_id);
INSERT OR IGNORE INTO rbac_user_roles (user_id) SELECT id FROM users;
CREATE TABLE IF NOT EXISTS admin_write_guard (request_id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok = 1));
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT 'success',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_log(created_at, id);
-- 与增量迁移保持同一保留规则，单次清理限量，避免审计写入扩大请求成本。
CREATE TRIGGER IF NOT EXISTS limit_admin_audit AFTER INSERT ON admin_audit_log BEGIN
  DELETE FROM admin_audit_log WHERE id IN (SELECT id FROM admin_audit_log
    WHERE created_at < datetime('now', '-90 days') OR id <= NEW.id - 10000 ORDER BY id LIMIT 100);
END;
CREATE TRIGGER IF NOT EXISTS assign_new_user_rbac AFTER INSERT ON users BEGIN
  INSERT INTO rbac_user_roles (user_id) VALUES (NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS protect_default_rbac_update BEFORE UPDATE ON rbac_roles
WHEN OLD.id = 1 BEGIN SELECT RAISE(ABORT, 'rbac_default_protected'); END;
CREATE TRIGGER IF NOT EXISTS protect_default_rbac_delete BEFORE DELETE ON rbac_roles
WHEN OLD.id = 1 BEGIN SELECT RAISE(ABORT, 'rbac_default_protected'); END;
CREATE TRIGGER IF NOT EXISTS protect_default_rbac_permissions BEFORE INSERT ON rbac_role_permissions
WHEN NEW.role_id = 1 BEGIN SELECT RAISE(ABORT, 'rbac_default_protected'); END;
CREATE TRIGGER IF NOT EXISTS protect_super_rbac_assignment BEFORE UPDATE ON rbac_user_roles
WHEN NEW.role_id != 1 AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND is_super_admin = 1)
BEGIN SELECT RAISE(ABORT, 'rbac_super_group'); END;
CREATE TRIGGER IF NOT EXISTS protect_last_super_update BEFORE UPDATE ON users
WHEN OLD.is_super_admin = 1 AND OLD.deleted_at IS NULL AND OLD.is_disabled = 0
  AND (OLD.disabled_until IS NULL OR OLD.disabled_until <= CURRENT_TIMESTAMP)
  AND (NEW.is_super_admin = 0 OR NEW.deleted_at IS NOT NULL OR NEW.is_disabled = 1 OR NEW.disabled_until > CURRENT_TIMESTAMP)
  AND NOT EXISTS (SELECT 1 FROM users WHERE id != OLD.id AND is_super_admin = 1 AND deleted_at IS NULL
    AND is_disabled = 0 AND (disabled_until IS NULL OR disabled_until <= CURRENT_TIMESTAMP))
BEGIN SELECT RAISE(ABORT, 'rbac_last_super'); END;
CREATE TRIGGER IF NOT EXISTS protect_last_super_delete BEFORE DELETE ON users
WHEN OLD.is_super_admin = 1 AND OLD.deleted_at IS NULL AND OLD.is_disabled = 0
  AND (OLD.disabled_until IS NULL OR OLD.disabled_until <= CURRENT_TIMESTAMP)
  AND NOT EXISTS (SELECT 1 FROM users WHERE id != OLD.id AND is_super_admin = 1 AND deleted_at IS NULL
    AND is_disabled = 0 AND (disabled_until IS NULL OR disabled_until <= CURRENT_TIMESTAMP))
BEGIN SELECT RAISE(ABORT, 'rbac_last_super'); END;

-- 每个用户最多三次登录；数据库自动淘汰最旧记录，避免依赖定时扫描和前端清理。
CREATE TABLE IF NOT EXISTS user_login_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT NOT NULL CHECK(length(ip) <= 64),
  login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT NOT NULL CHECK(length(user_agent) <= 1024),
  login_probe_id TEXT NOT NULL DEFAULT '',
  webrtc_ips TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(webrtc_ips) AND json_type(webrtc_ips) = 'array' AND json_array_length(webrtc_ips) <= 4 AND length(webrtc_ips) <= 193),
  webrtc_status TEXT NOT NULL DEFAULT 'not_run',
  webrtc_checked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_login_info_recent ON user_login_info(user_id, id DESC);
CREATE TRIGGER IF NOT EXISTS limit_user_login_info
AFTER INSERT ON user_login_info
BEGIN
  DELETE FROM user_login_info WHERE user_id = NEW.user_id AND id NOT IN (
    SELECT id FROM user_login_info WHERE user_id = NEW.user_id ORDER BY id DESC LIMIT 3
  );
END;

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  avatar_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
  dm_key TEXT UNIQUE,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  invited_by INTEGER,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (invited_by) REFERENCES users(id)
);

INSERT OR IGNORE INTO channels (name, description, kind, created_by)
VALUES ('general', '', 'public', NULL);

-- schema 可能会重复执行，幂等回填可顺手修复历史账号缺失的 general 成员关系。
INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
SELECT c.id, u.id, 'member', NULL
FROM channels c
CROSS JOIN users u
WHERE c.name = 'general'
  AND c.kind = 'public'
  AND c.deleted_at IS NULL
  AND u.deleted_at IS NULL;

-- 从数据库入口覆盖所有未来的建号路径，防止新入口忘记同步系统群成员关系。
CREATE TRIGGER IF NOT EXISTS add_new_user_to_general
AFTER INSERT ON users
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
  SELECT id, NEW.id, 'member', NULL
  FROM channels
  WHERE name = 'general'
    AND kind = 'public'
    AND deleted_at IS NULL;
END;

-- general 必须永久保留全部成员，数据库层兜底阻止任何遗漏的删除路径破坏不变量。
CREATE TRIGGER IF NOT EXISTS prevent_general_member_removal
BEFORE DELETE ON channel_members
WHEN EXISTS (
  SELECT 1
  FROM channels
	  WHERE id = OLD.channel_id
	    AND name = 'general'
)
  AND EXISTS (
    SELECT 1
    FROM users
    WHERE id = OLD.user_id
      AND deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'GENERAL_MEMBERSHIP_REQUIRED');
END;

-- 名称、公开属性和存活状态共同标识系统群，禁止绕过 API 改名、转私有或软删除。
CREATE TRIGGER IF NOT EXISTS protect_general_channel
BEFORE UPDATE OF name, kind, deleted_at ON channels
WHEN OLD.name = 'general'
  AND (
    NEW.name != 'general'
    OR NEW.kind != 'public'
    OR NEW.deleted_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'GENERAL_CHANNEL_REQUIRED');
END;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  sender_id INTEGER,
  content TEXT NOT NULL DEFAULT '',
  attachment_key TEXT,
  attachment_name TEXT,
  attachment_type TEXT,
  attachment_size INTEGER,
  attachment_kind TEXT CHECK (attachment_kind IS NULL OR attachment_kind IN ('voice', 'audio')),
  attachment_duration_ms INTEGER,
  attachment_waveform TEXT,
  sender_kind TEXT NOT NULL DEFAULT 'local' CHECK (sender_kind IN ('local', 'external')),
  external_sender_id TEXT,
  external_sender_name TEXT,
  external_sender_avatar_url TEXT,
  source TEXT NOT NULL DEFAULT 'edgechat',
  source_message_id TEXT,
  source_attachment_id TEXT,
  source_attachment_unique_id TEXT,
  client_message_id TEXT,
  mention_user_ids TEXT NOT NULL DEFAULT '[]',
  reply_to_message_id INTEGER,
  reply_to_sender_id INTEGER,
  bridge_binding_id TEXT,
  bridge_event_id TEXT,
  bridge_sent_at INTEGER,
  source_instance TEXT,
  bridge_target_revision INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  CHECK (
    (sender_kind = 'local' AND sender_id IS NOT NULL)
    OR (sender_kind = 'external' AND sender_id IS NULL)
  ),
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id != blocked_id),
  FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_pins (
  channel_id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE,
  pinned_by INTEGER,
  pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS message_reads (
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS site_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registration_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_by INTEGER,
  consumed_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (consumed_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS registration_invite_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_id INTEGER NOT NULL,
  user_id INTEGER,
  used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (invite_id, user_id),
  FOREIGN KEY (invite_id) REFERENCES registration_invites(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 校验和计数必须留在数据库事务内，防止并发注册同时消耗最后一次额度。
CREATE TRIGGER IF NOT EXISTS validate_registration_invite_use
BEFORE INSERT ON registration_invite_uses
BEGIN
  SELECT CASE
    WHEN NEW.user_id IS NULL THEN RAISE(ABORT, 'REGISTRATION_INVITE_USER_REQUIRED')
    WHEN NOT EXISTS (
      SELECT 1
      FROM registration_invites
      WHERE id = NEW.invite_id
        AND deleted_at IS NULL
        AND used_count < max_uses
    ) THEN RAISE(ABORT, 'REGISTRATION_INVITE_UNAVAILABLE')
  END;
END;

CREATE TRIGGER IF NOT EXISTS consume_registration_invite_use
AFTER INSERT ON registration_invite_uses
BEGIN
  UPDATE registration_invites
  SET used_count = used_count + 1,
      consumed_by_user_id = NEW.user_id,
      consumed_at = CASE
        WHEN used_count + 1 >= max_uses THEN CURRENT_TIMESTAMP
        ELSE NULL
      END
  WHERE id = NEW.invite_id;
END;

CREATE TABLE IF NOT EXISTS uploaded_files (
  object_key TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  client_upload_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  installation_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  refresh_token_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS realtime_tickets (
  token_hash TEXT PRIMARY KEY,
  access_token_ciphertext TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_session_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('room', 'inbox')),
  room_kind TEXT CHECK (room_kind IN ('public', 'private', 'dm')),
  room_id INTEGER,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_session_id) REFERENCES device_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_event_compaction (
  channel_id INTEGER PRIMARY KEY,
  compacted_through INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

-- 由数据库在消息写入事务内生成同步游标，HTTP 与 WebSocket 两条提交入口不会产生不同步的事件。
CREATE TRIGGER IF NOT EXISTS record_message_created_event
AFTER INSERT ON messages
BEGIN
  INSERT INTO message_events (channel_id, message_id, event_type)
  VALUES (NEW.channel_id, NEW.id, 'created');
END;

CREATE TRIGGER IF NOT EXISTS record_message_deleted_event
AFTER UPDATE OF deleted_at ON messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT INTO message_events (channel_id, message_id, event_type)
  VALUES (NEW.channel_id, NEW.id, 'deleted');
END;

-- 软删除后立即移除置顶引用；消息保留期仍由 GC 独立决定，不因置顶而延长。
CREATE TRIGGER IF NOT EXISTS clear_pin_after_message_soft_delete
AFTER UPDATE OF deleted_at ON messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM channel_pins WHERE message_id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS pending_r2_delete (
  object_key TEXT PRIMARY KEY,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- GC 按创建时间分页，并对仍在使用的附件和头像执行点查。
CREATE INDEX IF NOT EXISTS idx_gc_uploaded_created
ON uploaded_files(created_at, object_key);

CREATE INDEX IF NOT EXISTS idx_gc_message_attachment
ON messages(attachment_key)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gc_user_avatar
ON users(avatar_key)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gc_channel_avatar
ON channels(avatar_key)
WHERE deleted_at IS NULL;

-- 本地引用必须在写入瞬间仍有上传登记且未进入清理；外部 Bridge 附件没有本地上传归属，仅拦截 pending。
CREATE TRIGGER IF NOT EXISTS prevent_pending_message_attachment_insert
BEFORE INSERT ON messages
WHEN NEW.attachment_key IS NOT NULL
  AND (
    (
      NEW.sender_kind = 'local'
      AND NOT EXISTS (
        SELECT 1
        FROM uploaded_files
        WHERE object_key = NEW.attachment_key
          AND owner_user_id = NEW.sender_id
          AND NOT EXISTS (
            SELECT 1 FROM pending_r2_delete
            WHERE pending_r2_delete.object_key = uploaded_files.object_key
          )
      )
    )
    OR (
      NEW.sender_kind = 'external'
      AND EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE object_key = NEW.attachment_key
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_message_attachment_update
BEFORE UPDATE OF attachment_key ON messages
WHEN NEW.attachment_key IS NOT NULL
  AND (
    (
      NEW.sender_kind = 'local'
      AND NOT EXISTS (
        SELECT 1
        FROM uploaded_files
        WHERE object_key = NEW.attachment_key
          AND owner_user_id = NEW.sender_id
          AND NOT EXISTS (
            SELECT 1 FROM pending_r2_delete
            WHERE pending_r2_delete.object_key = uploaded_files.object_key
          )
      )
    )
    OR (
      NEW.sender_kind = 'external'
      AND EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE object_key = NEW.attachment_key
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_user_avatar_insert
BEFORE INSERT ON users
WHEN NEW.avatar_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = NEW.avatar_key
      AND owner_user_id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_user_avatar_update
BEFORE UPDATE OF avatar_key ON users
WHEN NEW.avatar_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = NEW.avatar_key
      AND owner_user_id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_channel_avatar_insert
BEFORE INSERT ON channels
WHEN NEW.avatar_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = NEW.avatar_key
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_channel_avatar_update
BEFORE UPDATE OF avatar_key ON channels
WHEN NEW.avatar_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = NEW.avatar_key
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_site_icon_insert
BEFORE INSERT ON site_settings
WHEN NEW.setting_key = 'site_icon_url'
  AND NEW.setting_value GLOB 'r2:*'
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = substr(NEW.setting_value, 4)
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_pending_site_icon_update
BEFORE UPDATE OF setting_value ON site_settings
WHEN NEW.setting_key = 'site_icon_url'
  AND NEW.setting_value GLOB 'r2:*'
  AND NOT EXISTS (
    SELECT 1
    FROM uploaded_files
    WHERE object_key = substr(NEW.setting_value, 4)
      AND NOT EXISTS (
        SELECT 1 FROM pending_r2_delete
        WHERE pending_r2_delete.object_key = uploaded_files.object_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_local_object_unavailable');
END;

INSERT OR IGNORE INTO site_settings (setting_key, setting_value)
VALUES ('site_name', 'SlimChat');

INSERT OR IGNORE INTO site_settings (setting_key, setting_value)
VALUES ('site_icon_url', '');

CREATE INDEX IF NOT EXISTS idx_messages_channel_created
  ON messages(channel_id, id DESC);

-- 会话列表按创建时间取最新存活消息，避免每个房间扫描整段历史。
CREATE INDEX IF NOT EXISTS idx_messages_channel_live_time
  ON messages(channel_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON messages(sender_id, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_source
  ON messages(source, source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_client_message
ON messages(channel_id, sender_id, client_message_id)
WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_reply_attention
ON messages(channel_id, reply_to_sender_id, id)
WHERE reply_to_sender_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_reads_user
  ON message_reads(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_channels_kind
  ON channels(kind, id DESC);

CREATE INDEX IF NOT EXISTS idx_users_username
  ON users(username);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
  ON user_blocks(blocked_id, blocker_id);

CREATE INDEX IF NOT EXISTS idx_registration_invites_active
  ON registration_invites(created_at DESC, deleted_at, consumed_at);

CREATE INDEX IF NOT EXISTS idx_registration_invites_usage
  ON registration_invites(deleted_at, used_count, max_uses, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_registration_invite_uses_invite
  ON registration_invite_uses(invite_id, used_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_r2_delete_next_retry
  ON pending_r2_delete(next_retry_at, retry_count);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_owner
  ON uploaded_files(owner_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_files_client_upload
  ON uploaded_files(owner_user_id, client_upload_id)
  WHERE client_upload_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sessions_refresh_token
  ON device_sessions(refresh_token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sessions_user_installation_active
  ON device_sessions(user_id, installation_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_sessions_user_active
  ON device_sessions(user_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_realtime_tickets_expiry
  ON realtime_tickets(expires_at, consumed_at);

CREATE INDEX IF NOT EXISTS idx_message_events_channel_sequence
  ON message_events(channel_id, sequence);

-- 本地会话表；token 只存 SHA-256。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload      TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 登录失败台账：进程重启后仍然限制暴力尝试。
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(scope_key, attempted_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL DEFAULT '',
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
