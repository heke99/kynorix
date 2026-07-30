import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(process.cwd(), '.next');
await rm(directory, { recursive: true, force: true });
process.stdout.write(`Cleared ${directory}.\n`);
