import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads repository-root environment files for workspace commands.
 * Existing process variables always win, followed by the most specific file.
 */
export function loadRootEnvironment(): string[] {
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  const environment = process.env.NODE_ENV ?? 'development';
  const candidates = [
    `.env.${environment}.local`,
    '.env.local',
    `.env.${environment}`,
    '.env',
  ];
  const loaded: string[] = [];

  for (const candidate of candidates) {
    const path = resolve(repositoryRoot, candidate);
    if (!existsSync(path)) continue;
    process.loadEnvFile(path);
    loaded.push(candidate);
  }

  return loaded;
}
