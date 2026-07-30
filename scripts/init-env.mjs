import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, '.env');
const templatePath = resolve(root, '.env.example');
const template = await readFile(templatePath, 'utf8');
let current = '';
try {
  current = await readFile(target, 'utf8');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}

const templateEntries = parse(template);
const currentEntries = parse(current);
const added = [];
for (const [key, value] of templateEntries) {
  if (!currentEntries.has(key)) {
    currentEntries.set(key, key === 'SESSION_ENCRYPTION_KEY' ? randomBytes(32).toString('base64url') : value);
    added.push(key);
  }
}

const sessionKey = currentEntries.get('SESSION_ENCRYPTION_KEY') ?? '';
if (!isValidSessionKey(sessionKey)) {
  currentEntries.set('SESSION_ENCRYPTION_KEY', randomBytes(32).toString('base64url'));
}

// Safely migrate an existing Supabase DATABASE_URL without copying localhost defaults.
const legacyDatabase = currentEntries.get('DATABASE_URL');
const supabaseDatabase = currentEntries.get('SUPABASE_DB_URL');
if (
  legacyDatabase &&
  /(?:supabase\.co|pooler\.supabase\.com)/i.test(legacyDatabase) &&
  (!supabaseDatabase || isPlaceholder(supabaseDatabase))
) {
  currentEntries.set('SUPABASE_DB_URL', legacyDatabase);
}

const supabaseUrl = currentEntries.get('SUPABASE_URL') ?? '';
const mobileSupabaseUrl = currentEntries.get('EXPO_PUBLIC_SUPABASE_URL') ?? '';
if (supabaseUrl && !isPlaceholder(supabaseUrl) && (!mobileSupabaseUrl || isPlaceholder(mobileSupabaseUrl))) {
  currentEntries.set('EXPO_PUBLIC_SUPABASE_URL', supabaseUrl);
}

const publishableKey = currentEntries.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const mobilePublishableKey = currentEntries.get('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY') ?? '';
if (
  publishableKey &&
  !isPlaceholder(publishableKey) &&
  (!mobilePublishableKey || isPlaceholder(mobilePublishableKey))
) {
  currentEntries.set('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', publishableKey);
}

const deprecatedKeys = new Set([
  'DATABASE_URL',
  'DATABASE_SSL',
  'REDIS_URL',
  'EVENT_BROKER_URL',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OIDC_ISSUER',
  'OIDC_AUDIENCE',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'NEXT_PUBLIC_OIDC_ACCOUNT_URL',
  'EXPO_PUBLIC_OIDC_ISSUER',
  'EXPO_PUBLIC_OIDC_CLIENT_ID',
]);
let removed = 0;
for (const key of deprecatedKeys) {
  if (currentEntries.delete(key)) removed += 1;
}

let repaired = 0;
for (const [key, templateValue] of templateEntries) {
  const currentValue = currentEntries.get(key) ?? '';
  if (!isLegacyPlaceholder(currentValue)) continue;
  if (key === 'SESSION_ENCRYPTION_KEY') {
    currentEntries.set(key, randomBytes(32).toString('base64url'));
    repaired += 1;
  } else if (!isLegacyPlaceholder(templateValue)) {
    currentEntries.set(key, templateValue);
    repaired += 1;
  } else if (key.endsWith('_PROVIDER_BASE_URL') || key.endsWith('_PROVIDER_API_KEY') || key === 'PAYMENT_PROVIDER_WEBHOOK_SECRET') {
    currentEntries.set(key, '');
    repaired += 1;
  }
}

const comments = template
  .split(/\r?\n/)
  .filter((line) => line.trim().startsWith('#'));
const output = [
  '# Generated from .env.example. Existing values are preserved.',
  ...comments,
  '',
  ...Array.from(currentEntries, ([key, value]) => `${key}=${value}`),
  '',
].join('\n');

await writeFile(target, output, { encoding: 'utf8', mode: 0o600 });
await chmod(target, 0o600);
const changes = [
  added.length ? `${added.length} added` : '',
  repaired ? `${repaired} repaired` : '',
  removed ? `${removed} deprecated removed` : '',
].filter(Boolean);
process.stdout.write(
  changes.length
    ? `Updated repository-root .env (${changes.join(', ')}).\n`
    : 'Repository-root .env contains every expected variable.\n',
);
process.stdout.write('Run npm run env:check before starting Zoryqon.\n');

function parse(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1));
  }
  return values;
}

function isPlaceholder(value) {
  return /YOUR_|replace-with|example\.com|localhost/i.test(value);
}

function isLegacyPlaceholder(value) {
  return /YOUR_|replace-with|example\.com|<project/i.test(value);
}

function isValidSessionKey(value) {
  try {
    return Buffer.from(value, 'base64url').byteLength === 32;
  } catch {
    return false;
  }
}
