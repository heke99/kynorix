import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

loadRootEnvironment();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@zoryqon/contracts'],
  poweredByHeader: false,
};

export default nextConfig;

function loadRootEnvironment() {
  const repositoryRoot = resolve(import.meta.dirname, '../..');
  const environment = process.env.NODE_ENV ?? 'development';
  for (const candidate of [
    `.env.${environment}.local`,
    '.env.local',
    `.env.${environment}`,
    '.env',
  ]) {
    const path = resolve(repositoryRoot, candidate);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}
