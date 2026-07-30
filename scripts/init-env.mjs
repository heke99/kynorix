import { randomBytes } from 'node:crypto';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, '.env');
const template = resolve(root, '.env.example');
const templateContents = await readFile(template, 'utf8');

let existingContents = '';
let existed = true;
try {
  await stat(target);
  existingContents = await readFile(target, 'utf8');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  existed = false;
}

const generatedSecrets = {
  SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  PAYMENT_PROVIDER_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
};

const templateVariables = readVariables(templateContents);
let contents = existingContents;
let added = 0;
let repaired = 0;

if (!existed) {
  contents = templateContents;
}

const currentVariables = readVariables(contents);
for (const [name, templateValue] of templateVariables) {
  if (currentVariables.has(name)) continue;
  const value = generatedSecrets[name] ?? templateValue;
  contents = appendVariable(contents, name, value);
  currentVariables.set(name, value);
  added += 1;
}

for (const [name, generatedValue] of Object.entries(generatedSecrets)) {
  const currentValue = currentVariables.get(name);
  if (!currentValue || isUnsafeDevelopmentSecret(name, currentValue)) {
    contents = replaceVariable(contents, name, generatedValue);
    currentVariables.set(name, generatedValue);
    repaired += 1;
  }
}

if (!contents.endsWith('\n')) contents += '\n';
await writeFile(target, contents, { encoding: 'utf8', mode: 0o600 });
await chmod(target, 0o600);

if (!existed) {
  process.stdout.write(
    'Created repository-root .env from .env.example with local cryptographic secrets.\n',
  );
} else if (added || repaired) {
  process.stdout.write(
    `Updated repository-root .env: added ${added} missing variable(s) and repaired ${repaired} local secret(s).\n`,
  );
} else {
  process.stdout.write('Repository-root .env is complete.\n');
}

function readVariables(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values.set(match[1], unquote(match[2]));
  }
  return values;
}

function appendVariable(contents, name, value) {
  const prefix = contents.length === 0 || contents.endsWith('\n') ? '' : '\n';
  return `${contents}${prefix}${name}=${value}\n`;
}

function replaceVariable(contents, name, value) {
  const expression = new RegExp(`^(\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=).*$`, 'm');
  if (expression.test(contents)) return contents.replace(expression, `$1${value}`);
  return appendVariable(contents, name, value);
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isUnsafeDevelopmentSecret(name, value) {
  if (value.startsWith('replace-with-')) return true;
  if (name === 'SESSION_ENCRYPTION_KEY') return value.length < 43;
  if (name === 'PAYMENT_PROVIDER_WEBHOOK_SECRET') return value.length < 32;
  return false;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
