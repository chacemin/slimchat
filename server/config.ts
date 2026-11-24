import { join, resolve } from 'node:path';

function bool(value: string | undefined, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
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
  /** Legacy env shape exposed on c.env so existing modules stay unchanged. */
  vars: Record<string, string | number>;
}

export function loadConfig(): Config {
  const env = process.env;
  const dataDir = resolve(env.SLIMCHAT_DATA_DIR || './data');
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
    keyringFile: resolve(env.SLIMCHAT_KEYRING_FILE || join(dataDir, 'secrets', 'keyring.json')),
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
