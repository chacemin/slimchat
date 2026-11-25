import { loadConfig } from '../server/config.ts';
import { createBackup } from '../server/backup.ts';

try {
  const result = createBackup(loadConfig());
  console.log(`Backup complete: ${result.target}`);
  console.log(
    `Database ${result.manifest.dbBytes} bytes · files ${result.manifest.fileCount} · active key ${result.manifest.keyringActiveKeyId}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
