import { loadConfig } from '../server/config.ts';
import { restoreBackup } from '../server/backup.ts';

const index = process.argv.indexOf('--from');
const from = index >= 0 ? process.argv[index + 1] : '';
if (!from) {
  console.error('Usage: bun scripts/restore.ts --from data/backups/<timestamp>');
  process.exit(1);
}

try {
  const result = restoreBackup(loadConfig(), from);
  console.log(`Restore complete from ${result.source}`);
  console.log(`Previous database copied to ${result.safety}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
