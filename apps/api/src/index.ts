import { loadRootEnvironment } from './load-root-env.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

loadRootEnvironment();

const config = loadConfig();
const app = await buildServer(config);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
