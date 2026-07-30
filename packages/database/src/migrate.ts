import { loadRootEnvironment } from './load-root-env.js';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

loadRootEnvironment();

const { Client } = pg;
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const databaseUrl = process.env.SUPABASE_DB_URL;
if (!databaseUrl) throw new Error('SUPABASE_DB_URL is required. Copy it from Supabase > Connect.');
const parsedUrl = new URL(databaseUrl);
if (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1') {
  throw new Error('SUPABASE_DB_URL still points to localhost. Use the Supabase direct or session-pooler URL.');
}
if (parsedUrl.port === '6543') {
  throw new Error(
    'Use the Supabase direct connection or session pooler on port 5432 for migrations, not transaction mode on port 6543.',
  );
}

const files = (await readdir(directory))
  .filter((file) => /^\d{14}_[a-z0-9_]+\.sql$/.test(file))
  .sort();
const versions = new Set<string>();
for (const file of files) {
  const version = file.slice(0, 14);
  if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
  versions.add(version);
}

const client = new Client({
  connectionString: databaseUrl,
  application_name: 'zoryqon-migrations',
  ssl: { rejectUnauthorized: process.env.SUPABASE_DB_SSL === 'verify-full' },
});
await client.connect();
try {
  await client.query('select pg_advisory_lock($1)', [1_963_074_903]);
  await client.query(`
    create table if not exists public.schema_migrations (
      version text primary key,
      filename text not null unique,
      checksum_sha256 text not null,
      applied_at timestamptz not null default clock_timestamp()
    )
  `);
  for (const file of files) {
    const sql = await readFile(resolve(directory, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const version = file.slice(0, 14);
    const existing = await client.query<{
      checksum_sha256: string;
      filename: string;
    }>('select checksum_sha256, filename from public.schema_migrations where version = $1', [
      version,
    ]);
    if (existing.rowCount) {
      const row = existing.rows[0]!;
      if (row.checksum_sha256 !== checksum || row.filename !== file) {
        throw new Error(`Applied migration drift detected: ${file}`);
      }
      process.stdout.write(`already applied ${file}\n`);
      continue;
    }
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        'insert into public.schema_migrations(version, filename, checksum_sha256) values ($1, $2, $3)',
        [version, file, checksum],
      );
      await client.query('commit');
      process.stdout.write(`applied ${file}\n`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
} finally {
  await client.query('select pg_advisory_unlock($1)', [1_963_074_903]).catch(() => undefined);
  await client.end();
}
