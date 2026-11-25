import { closeEnv, createEnv } from './env.ts';
import { createBackup, restoreBackup } from './backup.ts';
import { bootstrapAdmin } from './bootstrap.ts';
import type { Config } from './config.ts';
import {
  databaseHasUserData,
  hasKeyring,
  initKeyring,
  rotateKeyring
} from './security/keyring.ts';

function helpText() {
  return `SlimChat standalone commands:

  slimchat                     start the server (first run creates data/)
  slimchat init                create keyring, migrate database and optional admin
  slimchat admin               create the first administrator
  slimchat migrate             apply pending database migrations
  slimchat keyring:init        create data/secrets/keyring.json
  slimchat keyring:rotate      add a new active key, keeping old keys
  slimchat backup              create data/backups/<timestamp>/
  slimchat restore --from DIR  restore a backup directory
  slimchat help                show this help

Environment:
  SLIMCHAT_DATA_DIR            data directory (default: ./data next to the executable)
  SLIMCHAT_ADMIN_USERNAME      first administrator username
  SLIMCHAT_ADMIN_PASSWORD      first administrator password
  SLIMCHAT_ADMIN_DISPLAY_NAME  first administrator display name`;
}

function adminPassword() {
  let password = String(process.env.SLIMCHAT_ADMIN_PASSWORD || '');
  if (!password && process.stdin.isTTY) {
    password = String((globalThis as any).prompt?.('SLIMCHAT_ADMIN_PASSWORD:') || '');
  }
  return password;
}

function ensureKeyringCanBeCreated(config: Config, force = false) {
  if (hasKeyring(config)) return false;
  if (databaseHasUserData(config) && !force) {
    throw new Error(
      `Database ${config.dbPath} already contains users or messages, but no keyring was found at ${config.keyringFile}. ` +
        'Restore the keyring from backup instead of generating a new one, or use "keyring:init --force" only if the data is disposable.'
    );
  }
  return true;
}

export async function runCli(args: string[], config: Config): Promise<boolean> {
  const command = (args[0] || 'serve').toLowerCase();
  const rest = args.slice(1);

  if (command === 'serve' || command === 'start') return false;
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(helpText());
    return true;
  }

  if (command === 'init') {
    const create = ensureKeyringCanBeCreated(config);
    if (create) {
      const result = initKeyring(config);
      console.log(`Keyring created: ${result.path}`);
      console.log('Back up data/secrets/keyring.json separately; losing it makes data unreadable.');
    } else {
      console.log(`Keyring already exists: ${config.keyringFile}`);
    }
    const env = createEnv(config);
    try {
      const password = adminPassword();
      if (password) {
        const admin = await bootstrapAdmin(env, config, { password });
        if (admin.status === 'created') {
          console.log(`Super administrator created: ${admin.username} (id ${admin.userId})`);
        } else if (admin.status === 'exists') {
          console.log(`Administrator "${admin.username}" already exists; nothing changed.`);
        }
      } else {
        console.log('No SLIMCHAT_ADMIN_PASSWORD set; create an administrator later with "slimchat admin".');
      }
    } finally {
      closeEnv(env);
    }
    return true;
  }

  if (command === 'admin') {
    const env = createEnv(config);
    try {
      const password = adminPassword();
      if (!password) throw new Error('Set SLIMCHAT_ADMIN_PASSWORD first.');
      const admin = await bootstrapAdmin(env, config, { password });
      if (admin.status === 'created') {
        console.log(`Super administrator created: ${admin.username} (id ${admin.userId})`);
      } else if (admin.status === 'exists') {
        console.log(`Administrator "${admin.username}" already exists; nothing changed.`);
      } else {
        console.log('Administrator was not created.');
      }
    } finally {
      closeEnv(env);
    }
    return true;
  }

  if (command === 'migrate') {
    const env = createEnv(config);
    closeEnv(env);
    console.log(`Migrations applied: ${config.dbPath}`);
    return true;
  }

  if (command === 'keyring:init' || command === 'keyring-init') {
    const force = rest.includes('--force');
    ensureKeyringCanBeCreated(config, force);
    const result = initKeyring(config);
    console.log(
      result.created ? `Keyring created: ${result.path}` : `Keyring already exists: ${result.path}`
    );
    return true;
  }

  if (command === 'keyring:rotate' || command === 'keyring-rotate') {
    const next = rotateKeyring(config);
    console.log(`Active key switched to ${next}. Old keys were kept for decryption.`);
    return true;
  }

  if (command === 'backup') {
    const result = createBackup(config);
    console.log(`Backup complete: ${result.target}`);
    console.log(
      `Database ${result.manifest.dbBytes} bytes · files ${result.manifest.fileCount} · active key ${result.manifest.keyringActiveKeyId}`
    );
    return true;
  }

  if (command === 'restore') {
    const index = rest.indexOf('--from');
    const from = index >= 0 ? rest[index + 1] : '';
    if (!from) throw new Error('Usage: slimchat restore --from data/backups/<timestamp>');
    const result = restoreBackup(config, from);
    console.log(`Restore complete from ${result.source}`);
    console.log(`Previous database copied to ${result.safety}`);
    return true;
  }

  throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
}
