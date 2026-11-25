import { closeEnv, createEnv } from '../server/env.ts';
import { loadConfig } from '../server/config.ts';
import { bootstrapAdmin } from '../server/bootstrap.ts';

const config = loadConfig();
let password = String(process.env.SLIMCHAT_ADMIN_PASSWORD || '');
if (!password && process.stdin.isTTY) {
  password = String((globalThis as any).prompt?.(`Password for ${config.adminUsername}:`) || '');
}
if (!password) {
  console.error('Set SLIMCHAT_ADMIN_PASSWORD (or put it in .env) first.');
  process.exit(1);
}

const env = createEnv(config);
try {
  const result = await bootstrapAdmin(env, config, { password });
  if (result.status === 'created') {
    console.log(`Super administrator created: ${result.username} (id ${result.userId})`);
  } else if (result.status === 'exists') {
    console.log(`User "${result.username}" already exists; nothing changed.`);
  } else {
    console.log('Administrator was not created.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  closeEnv(env);
}
