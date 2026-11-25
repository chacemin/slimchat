import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Config } from './config.ts';

function countFiles(dir: string) {
  let count = 0;
  if (!existsSync(dir)) return count;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) count += countFiles(full);
      else count += 1;
    }
  } catch {
    // A missing or unreadable directory contributes zero files.
  }
  return count;
}

export function createBackup(config: Config) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(config.dataDir, 'backups', stamp);
  mkdirSync(target, { recursive: true });

  if (!existsSync(config.dbPath)) {
    throw new Error(`Database not found: ${config.dbPath}`);
  }
  if (!existsSync(config.keyringFile)) {
    throw new Error(
      `Keyring not found: ${config.keyringFile}. Backing up without it makes data unreadable.`
    );
  }

  const db = new Database(config.dbPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec(`VACUUM INTO '${join(target, 'slimchat.db').replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }

  if (existsSync(config.filesDir)) {
    cpSync(config.filesDir, join(target, 'files'), { recursive: true });
  }
  mkdirSync(join(target, 'secrets'), { recursive: true });
  cpSync(config.keyringFile, join(target, 'secrets', 'keyring.json'));

  const dbBytes = readFileSync(join(target, 'slimchat.db'));
  const keyring = JSON.parse(readFileSync(config.keyringFile, 'utf8'));
  const manifest = {
    ts: new Date().toISOString(),
    schemaVersion: 1,
    dbSha256: createHash('sha256').update(dbBytes).digest('hex'),
    dbBytes: statSync(join(target, 'slimchat.db')).size,
    fileCount: countFiles(join(target, 'files')),
    keyringActiveKeyId: keyring.activeKeyId || ''
  };
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { target, manifest };
}

export function restoreBackup(config: Config, from: string) {
  const source = resolve(from);
  const manifestPath = join(source, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.dbSha256 || !manifest.keyringActiveKeyId) {
    throw new Error('Backup manifest is incomplete (database checksum or keyring id missing).');
  }
  if (!existsSync(join(source, 'secrets', 'keyring.json'))) {
    throw new Error('Backup is missing secrets/keyring.json; refusing to restore unreadable data.');
  }

  const safety = join(config.dataDir, 'backups', `pre-restore-${Date.now()}`);
  mkdirSync(safety, { recursive: true });
  for (const item of ['slimchat.db', 'slimchat.db-wal', 'slimchat.db-shm']) {
    const path = join(config.dataDir, item);
    if (existsSync(path)) cpSync(path, join(safety, item));
  }

  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(join(config.dataDir, 'secrets'), { recursive: true, mode: 0o700 });
  for (const item of ['slimchat.db', 'slimchat.db-wal', 'slimchat.db-shm']) {
    const path = join(config.dataDir, item);
    if (existsSync(path)) rmSync(path);
  }
  cpSync(join(source, 'slimchat.db'), join(config.dataDir, 'slimchat.db'));
  if (existsSync(join(source, 'files'))) {
    rmSync(config.filesDir, { recursive: true, force: true });
    cpSync(join(source, 'files'), config.filesDir, { recursive: true });
  }
  cpSync(join(source, 'secrets', 'keyring.json'), config.keyringFile);
  return { source, safety, manifest };
}
