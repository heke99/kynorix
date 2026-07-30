import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
loadRootEnvironment(root);

for (const key of [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
]) {
  if (!process.env[key]) throw new Error(`${key} is required for the mobile application.`);
}

const executable = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'expo.cmd' : 'expo');
if (!existsSync(executable)) {
  throw new Error('Expo is not installed. Run npm ci from the repository root.');
}

const child = spawn(executable, ['start', ...process.argv.slice(2)], {
  cwd: resolve(root, 'apps/mobile'),
  env: process.env,
  stdio: 'inherit',
});
child.on('error', (error) => {
  process.stderr.write(`Unable to start Expo: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

function loadRootEnvironment(directory) {
  const environment = process.env.NODE_ENV ?? 'development';
  for (const filename of [`.env.${environment}.local`, '.env.local', `.env.${environment}`, '.env']) {
    const path = resolve(directory, filename);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}
