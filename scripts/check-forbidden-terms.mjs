import { spawnSync } from 'node:child_process';

const patterns = [
  'sand' + 'box',
  'de' + 'mo',
  'virtual ' + 'money',
  'virtual ' + 'balance',
  'virtual ' + 'settlement',
  'V' + 'SEK',
  'x-kynorix-' + 'user',
  'x-kynorix-' + 'admin',
  'mock-' + 'chart',
  'sv-' + 'SE',
];

const result = spawnSync(
  'rg',
  [
    '-n',
    '-i',
    patterns.join('|'),
    '--glob',
    '!node_modules/**',
    '--glob',
    '!.git/**',
    '--glob',
    '!package-lock.json',
    '.',
  ],
  { encoding: 'utf8' },
);

if (result.status === 0) {
  process.stderr.write(result.stdout);
  process.exitCode = 1;
} else if (result.status === 1) {
  process.stdout.write('Forbidden terminology check passed\n');
} else {
  process.stderr.write(result.stderr || 'Forbidden terminology check failed to run.\n');
  process.exitCode = result.status ?? 1;
}
