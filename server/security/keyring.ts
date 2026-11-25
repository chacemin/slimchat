import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Config } from '../config.ts';

export interface KeyringFile {
  activeKeyId: string;
  keys: Record<string, string>;
}

export function hasKeyring(config: Config) {
  return existsSync(config.keyringFile);
}

export function readKeyringFile(config: Config): KeyringFile {
  if (!existsSync(config.keyringFile)) {
    return { activeKeyId: '', keys: {} };
  }
  return JSON.parse(readFileSync(config.keyringFile, 'utf8'));
}

export function writeKeyringFile(config: Config, keyring: KeyringFile) {
  mkdirSync(dirname(config.keyringFile), { recursive: true, mode: 0o700 });
  writeFileSync(config.keyringFile, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(config.keyringFile, 0o600);
  } catch {
    // Windows ACLs are handled by the OS; ignore POSIX mode failures.
  }
}

export function initKeyring(config: Config) {
  if (hasKeyring(config)) {
    return { created: false, path: config.keyringFile };
  }
  const key = randomBytes(32).toString('base64');
  writeKeyringFile(config, { activeKeyId: 'k1', keys: { k1: key } });
  return { created: true, path: config.keyringFile };
}

export function rotateKeyring(config: Config) {
  const keyring = readKeyringFile(config);
  if (!keyring.activeKeyId) {
    throw new Error('No keyring found. Run "slimchat init" or "bun run keyring:init" first.');
  }
  const next = `k${Object.keys(keyring.keys).length + 1}`;
  keyring.keys[next] = randomBytes(32).toString('base64');
  keyring.activeKeyId = next;
  writeKeyringFile(config, keyring);
  return next;
}

/** True when a database already contains accounts or messages but its keyring is gone. */
export function databaseHasUserData(config: Config) {
  if (!existsSync(config.dbPath)) return false;
  let db: Database | null = null;
  try {
    db = new Database(config.dbPath, { readonly: true });
    const row = db
      .query('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM messages) AS n')
      .get() as { n?: number } | null;
    return Number(row?.n || 0) > 0;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
