import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const key = randomBytes(32).toString('base64');
const contents = [
  'REMINDERS_OWNER_ID=local_seedy',
  'APP_ORIGIN=http://127.0.0.1:5173',
  'ENCRYPTION_KEY_ID=local-synthetic',
  `ENCRYPTION_KEYS_JSON='${JSON.stringify({ 'local-synthetic': key })}'`,
  '',
].join('\n');
await writeFile('.dev.vars', contents, { flag: 'wx', mode: 0o600 });
console.log('Created ignored .dev.vars for loopback synthetic development. Existing files are never overwritten.');
