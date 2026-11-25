import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const target = process.argv[2] || 'bun-linux-x64';
const allowed = new Set([
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-x64',
  'bun-darwin-x64',
  'bun-darwin-arm64'
]);
if (!allowed.has(target)) {
  console.error(`Unsupported target: ${target}`);
  console.error(`Supported: ${[...allowed].join(', ')}`);
  process.exit(1);
}

if (!existsSync(join(process.cwd(), 'frontend', 'dist', 'index.html'))) {
  console.error('frontend/dist/index.html is missing. Run "bun run build" first.');
  process.exit(1);
}

const releaseDir = join(process.cwd(), 'release');
mkdirSync(releaseDir, { recursive: true });
const suffix = target.replace(/^bun-/, '');
const outfile = join(releaseDir, `slimchat-${suffix}${target.includes('windows') ? '.exe' : ''}`);

console.log(`Building standalone executable: ${outfile}`);
const result = spawnSync(
  process.execPath,
  [
    'build',
    '--compile',
    '--target',
    target,
    '--asset',
    'frontend/dist',
    '--asset',
    'server/db/schema.sql',
    '--asset',
    'server/db/migrations',
    'server/index.ts',
    '--outfile',
    outfile
  ],
  { stdio: 'inherit' }
);

if (result.status !== 0) {
  console.error(`Standalone build failed for ${target}`);
  process.exit(result.status || 1);
}
console.log(`Done: ${outfile}`);
