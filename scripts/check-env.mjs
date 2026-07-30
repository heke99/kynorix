import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const environment = process.env.NODE_ENV ?? 'development';
for (const candidate of [`.env.${environment}.local`, '.env.local', `.env.${environment}`, '.env']) {
  const path = resolve(root, candidate);
  if (existsSync(path)) process.loadEnvFile(path);
}

const required = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_DB_URL',
  'SESSION_ENCRYPTION_KEY',
  'ZORYQON_TENANT_REF',
  'WEB_ORIGINS',
  'NEXT_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
];
const failures = [];
for (const key of required) {
  const value = process.env[key]?.trim();
  if (!value) failures.push(`${key} is missing.`);
  else if (/YOUR_|replace-with|example\.com|<project/i.test(value)) {
    failures.push(`${key} still contains a placeholder.`);
  }
}

validateUrl('SUPABASE_URL', ['https:']);
validateUrl('SUPABASE_DB_URL', ['postgres:', 'postgresql:']);
validateUrl('NEXT_PUBLIC_API_URL', ['http:', 'https:']);

const databaseUrl = process.env.SUPABASE_DB_URL;
if (databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
      failures.push('SUPABASE_DB_URL points to localhost instead of Supabase.');
    }
    if (parsed.port === '6543') {
      failures.push('SUPABASE_DB_URL uses transaction-pooler port 6543. Use direct/session port 5432.');
    }
  } catch {
    // URL validation already reports this.
  }
}

const sessionKey = process.env.SESSION_ENCRYPTION_KEY ?? '';
try {
  if (Buffer.from(sessionKey, 'base64url').byteLength !== 32) {
    failures.push('SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
} catch {
  failures.push('SESSION_ENCRYPTION_KEY is not valid base64url.');
}

for (const prefix of ['PAYMENT', 'CUSTODY', 'PRICE', 'COMPLIANCE', 'NOTIFICATION']) {
  const url = process.env[`${prefix}_PROVIDER_BASE_URL`]?.trim();
  const key = process.env[`${prefix}_PROVIDER_API_KEY`]?.trim();
  if (Boolean(url) !== Boolean(key)) failures.push(`${prefix} provider URL and API key must be set together.`);
}
const paymentConfigured = Boolean(process.env.PAYMENT_PROVIDER_BASE_URL?.trim());
const webhookSecret = process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET?.trim() ?? '';
if (paymentConfigured && webhookSecret.length < 32) {
  failures.push('PAYMENT_PROVIDER_WEBHOOK_SECRET must contain at least 32 characters.');
}

if (failures.length) {
  process.stderr.write(`Supabase environment is not ready:\n- ${failures.join('\n- ')}\n`);
  process.stderr.write('Open .env and copy the real values from the Supabase dashboard.\n');
  process.exitCode = 1;
} else {
  process.stdout.write('Supabase environment configuration is valid.\n');
}

function validateUrl(key, protocols) {
  const value = process.env[key];
  if (!value) return;
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) failures.push(`${key} uses an unsupported protocol.`);
  } catch {
    failures.push(`${key} is not a valid URL.`);
  }
}
