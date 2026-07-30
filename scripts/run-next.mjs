import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2];
loadRootEnvironment(root, mode === 'build' || mode === 'start' ? 'production' : 'development');

const executable = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'next.cmd' : 'next');
if (!existsSync(executable)) {
  throw new Error('Next.js is not installed. Run npm ci from the repository root.');
}

const child = spawn(executable, process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
child.on('error', (error) => {
  process.stderr.write(`Unable to start Next.js: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

function loadRootEnvironment(directory, defaultEnvironment) {
  const environment = process.env.NODE_ENV ?? defaultEnvironment;
  for (const filename of [`.env.${environment}.local`, '.env.local', `.env.${environment}`, '.env']) {
    const path = resolve(directory, filename);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}
