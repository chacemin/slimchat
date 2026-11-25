import { loadConfig } from '../server/config.ts';
import { initKeyring, rotateKeyring } from '../server/security/keyring.ts';

const config = loadConfig();
const command = process.argv[2] || 'init';

try {
  if (command === 'init') {
    const result = initKeyring(config);
    console.log(
      result.created ? `Keyring created: ${result.path}` : `Keyring already exists: ${result.path}`
    );
    if (result.created) {
      console.log('Back this file up separately; losing it makes existing messages and attachments unreadable.');
    }
  } else if (command === 'rotate') {
    const next = rotateKeyring(config);
    console.log(`Active key switched to ${next}. Old keys were kept for decryption.`);
  } else {
    console.error('Usage: bun scripts/keyring.ts <init|rotate>');
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
