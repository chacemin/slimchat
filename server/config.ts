import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function bool(value: string | undefined, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function standalone() {
  return Boolean((Bun as any).isStandaloneExecutable);
}

function executableDirectory() {
  try {
    return dirname(process.execPath);
  } catch {
    return process.cwd();
  }
}

/** Load .env next to a standalone executable without overriding real environment variables. */
function loadStandaloneDotEnv(baseDir: string) {
  const path = join(baseDir, '.env');
  if (!existsSync(path)) return;
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  filesDir: string;
  logDir: string;
  keyringFile: string;
  publicOrigin: string;
  trustProxy: boolean;
  adminUsername: string;
  adminDisplayName: string;
  siteOrigins: string[];
  sessionTtlDays: number;
  loginLimit: number;
  apiLimit: number;
  loginGateEnabled: boolean;
  loginGatePassword: string;
  maxFileSize: number;
  allowedFileTypes: string;
  messageRetentionDays: number;
  softDeleteRetentionDays: number;
  orphanUploadRetentionDays: number;
  gcCronHour: number;
  logLevel: string;
  turnUrl: string;
  turnUsername: string;
  turnCredential: string;
  turnSharedSecret: string;
  /** True when running from a `bun build --compile` executable. */
  standalone: boolean;
  /** Directory used to resolve relative paths (executable directory when standalone). */
  baseDir: string;
  /** Legacy env shape exposed on c.env so existing modules stay unchanged. */
  vars: Record<string, string | number>;
}

export function loadConfig(): Config {
  const standaloneBuild = standalone();
  const baseDir = standaloneBuild ? executableDirectory() : process.cwd();
  if (standaloneBuild) loadStandaloneDotEnv(baseDir);

  const env = process.env;
  const dataDirRaw = env.SLIMCHAT_DATA_DIR || (standaloneBuild ? 'data' : './data');
  const dataDir = isAbsolute(dataDirRaw) ? resolve(dataDirRaw) : resolve(baseDir, dataDirRaw);
  const keyringRaw = env.SLIMCHAT_KEYRING_FILE || join(dataDir, 'secrets', 'keyring.json');
  const keyringFile = isAbsolute(keyringRaw) ? resolve(keyringRaw) : resolve(baseDir, keyringRaw);
  const publicOrigin = (env.SLIMCHAT_PUBLIC_ORIGIN || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const siteOrigins = (env.SLIMCHAT_SITE_ORIGINS || publicOrigin)
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const maxFileSize = int(env.SLIMCHAT_MAX_FILE_SIZE, 20 * 1024 * 1024);

  const config: Config = {
    host: env.SLIMCHAT_HOST || '127.0.0.1',
    port: int(env.SLIMCHAT_PORT, 8787),
    dataDir,
    dbPath: join(dataDir, 'slimchat.db'),
    filesDir: join(dataDir, 'files'),
    logDir: join(dataDir, 'logs'),
    keyringFile,
    publicOrigin,
    trustProxy: bool(env.SLIMCHAT_TRUST_PROXY),
    adminUsername: env.SLIMCHAT_ADMIN_USERNAME || 'admin',
    adminDisplayName: env.SLIMCHAT_ADMIN_DISPLAY_NAME || '管理员',
    siteOrigins,
    sessionTtlDays: int(env.SLIMCHAT_SESSION_TTL_DAYS, 30),
    loginLimit: int(env.SLIMCHAT_LOGIN_LIMIT, 10),
    apiLimit: int(env.SLIMCHAT_API_LIMIT, 120),
    loginGateEnabled: bool(env.SLIMCHAT_LOGIN_GATE_ENABLED),
    loginGatePassword: env.SLIMCHAT_LOGIN_GATE_PASSWORD || '',
    maxFileSize,
    allowedFileTypes: env.SLIMCHAT_ALLOWED_FILE_TYPES || 'image/,video/,audio/,application/pdf,text/',
    messageRetentionDays: int(env.SLIMCHAT_MESSAGE_RETENTION_DAYS, 30),
    softDeleteRetentionDays: int(env.SLIMCHAT_SOFT_DELETE_RETENTION_DAYS, 60),
    orphanUploadRetentionDays: int(env.SLIMCHAT_ORPHAN_UPLOAD_RETENTION_DAYS, 1),
    gcCronHour: Math.min(23, int(env.SLIMCHAT_GC_CRON_HOUR, 3)),
    logLevel: env.SLIMCHAT_LOG_LEVEL || 'info',
    turnUrl: env.SLIMCHAT_TURN_URL || '',
    turnUsername: env.SLIMCHAT_TURN_USERNAME || '',
    turnCredential: env.SLIMCHAT_TURN_CREDENTIAL || '',
    turnSharedSecret: env.SLIMCHAT_TURN_SHARED_SECRET || '',
    standalone: standaloneBuild,
    baseDir,
    vars: {}
  };

  config.vars = {
    MAX_FILE_SIZE: maxFileSize,
    ALLOWED_FILE_TYPES: config.allowedFileTypes,
    MESSAGE_RETENTION_DAYS: config.messageRetentionDays,
    SOFT_DELETE_RETENTION_DAYS: config.softDeleteRetentionDays,
    ORPHAN_UPLOAD_RETENTION_DAYS: config.orphanUploadRetentionDays,
    R2_DELETE_MAX_RETRY: env.SLIMCHAT_FILE_DELETE_MAX_RETRY || '8',
    GC_BATCH_SIZE: env.SLIMCHAT_GC_BATCH_SIZE || '',
    GC_MAX_BATCHES_PER_RUN: env.SLIMCHAT_GC_MAX_BATCHES_PER_RUN || '',
    GC_INTERNAL_OPERATION_BUDGET: env.SLIMCHAT_GC_INTERNAL_OPERATION_BUDGET || '',
    GC_D1_STATEMENT_BUDGET: env.SLIMCHAT_GC_D1_STATEMENT_BUDGET || '',
    GC_R2_OPERATION_BUDGET: env.SLIMCHAT_GC_FILE_OPERATION_BUDGET || '',
    SITE_ORIGINS: siteOrigins.join(','),
    ADMIN_USERNAMES: config.adminUsername,
    SLIMCHAT_SITE_ORIGINS: siteOrigins.join(',')
  };

  return config;
}

export function loadKeyringFile(path: string) {
  return Bun.file(path);
}
