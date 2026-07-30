import { randomBytes } from 'node:crypto';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, '.env');
const template = resolve(root, '.env.example');

try {
  await stat(target);
  process.stdout.write('Using existing repository-root .env file.\n');
  process.exit(0);
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}

let contents = await readFile(template, 'utf8');
contents = contents
  .replace(
    /^SESSION_ENCRYPTION_KEY=.*$/m,
    `SESSION_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`,
  )
  .replace(
    /^PAYMENT_PROVIDER_WEBHOOK_SECRET=.*$/m,
    `PAYMENT_PROVIDER_WEBHOOK_SECRET=${randomBytes(32).toString('hex')}`,
  );

await writeFile(target, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
await chmod(target, 0o600);
process.stdout.write(
  'Created .env from .env.example with local cryptographic secrets. Replace every provider, OIDC and tenant placeholder before using those flows.\n',
);
