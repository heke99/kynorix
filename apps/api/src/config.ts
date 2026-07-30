export interface ApiConfig {
  host: string;
  port: number;
  webOrigins: string[];
  sandboxMode: true;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const forbiddenFlags = [
    'KYNORIX_REAL_MONEY_ENABLED',
    'KYNORIX_FIVE_MINUTE_MARKETS_ENABLED',
    'KYNORIX_CUSTODY_ENABLED',
    'KYNORIX_SPOT_CRYPTO_ENABLED',
  ];
  for (const flag of forbiddenFlags) {
    if (env[flag]?.toLowerCase() === 'true') {
      throw new Error(`${flag}=true is denied in this sandbox build`);
    }
  }
  if (env.KYNORIX_SANDBOX_MODE?.toLowerCase() === 'false') {
    throw new Error('This release cannot run outside sandbox mode');
  }
  const port = Number(env.API_PORT ?? 4000);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('API_PORT must be a valid TCP port');
  }
  return {
    host: env.API_HOST ?? '0.0.0.0',
    port,
    webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:3000,http://localhost:3001')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    sandboxMode: true,
  };
}
