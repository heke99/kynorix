import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migrationDirectory = resolve(root, 'packages/database/migrations');
const manifest = JSON.parse(
  await readFile(resolve(root, 'scripts/migration-history-manifest.json'), 'utf8'),
);
const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
const versions = new Set();
const failures = [];

for (const file of files) {
  const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(file);
  if (!match) {
    failures.push(`Invalid migration filename: ${file}`);
    continue;
  }
  const version = match[1];
  if (versions.has(version)) failures.push(`Duplicate migration version: ${version}`);
  versions.add(version);
  const expected = manifest.migrations.find((entry) => entry.filename === file);
  if (!expected) {
    failures.push(`Migration missing from manifest: ${file}`);
    continue;
  }
  if (expected.version !== version) failures.push(`Manifest version mismatch: ${file}`);
  const checksum = createHash('sha256')
    .update(await readFile(resolve(migrationDirectory, file)))
    .digest('hex');
  if (expected.sha256 !== checksum) failures.push(`Checksum mismatch: ${file}`);
}

for (const entry of manifest.migrations) {
  if (!files.includes(entry.filename))
    failures.push(`Manifest entry has no file: ${entry.filename}`);
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${files.length} migration(s), unique versions and checksums verified\n`);
}
