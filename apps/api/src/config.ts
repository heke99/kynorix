import { z } from 'zod';

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().max(65_535).default(4000),
  WEB_ORIGINS: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().url(),
  SUPABASE_DB_SSL: z.enum(['require', 'verify-full']).default('require'),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).default('authenticated'),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('zoryqon-private'),
  SESSION_ENCRYPTION_KEY: z.string().min(43),
  SESSION_MAX_AGE_SECONDS: z.coerce.number().int().min(3600).max(31_536_000).default(2_592_000),
  ZORYQON_TENANT_REF: z.string().min(1),
  PAYMENT_PROVIDER_BASE_URL: optionalUrl,
  PAYMENT_PROVIDER_API_KEY: optionalSecret,
  PAYMENT_PROVIDER_WEBHOOK_SECRET: optionalSecret,
  CUSTODY_PROVIDER_BASE_URL: optionalUrl,
  CUSTODY_PROVIDER_API_KEY: optionalSecret,
  PRICE_PROVIDER_BASE_URL: optionalUrl,
  PRICE_PROVIDER_API_KEY: optionalSecret,
  COMPLIANCE_PROVIDER_BASE_URL: optionalUrl,
  COMPLIANCE_PROVIDER_API_KEY: optionalSecret,
  RESOLUTION_DISPUTE_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

export interface ApiConfig {
  environment: 'development' | 'test' | 'staging' | 'production';
  host: string;
  port: number;
  webOrigins: string[];
  databaseUrl: string;
  databaseSsl: 'require' | 'verify-full';
  tenantRef: string;
  sessionEncryptionKey: string;
  sessionMaxAgeSeconds: number;
  supabase: {
    url: string;
    publishableKey: string;
    secretKey: string;
    jwtAudience: string;
    storageBucket: string;
  };
  providers: {
    payment: (ProviderConfig & { webhookSecret: string }) | null;
    custody: ProviderConfig | null;
    price: ProviderConfig | null;
    compliance: ProviderConfig | null;
  };
  logLevel: string;
  trustProxy: boolean;
  resolutionDisputeWindowHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid or missing API configuration: ${missing}`);
  }
  const value = parsed.data;
  assertSupabaseConfiguration(value);

  const payment = providerWithWebhook(
    value.PAYMENT_PROVIDER_BASE_URL,
    value.PAYMENT_PROVIDER_API_KEY,
    value.PAYMENT_PROVIDER_WEBHOOK_SECRET,
  );
  const custody = provider(value.CUSTODY_PROVIDER_BASE_URL, value.CUSTODY_PROVIDER_API_KEY);
  const price = provider(value.PRICE_PROVIDER_BASE_URL, value.PRICE_PROVIDER_API_KEY);
  const compliance = provider(
    value.COMPLIANCE_PROVIDER_BASE_URL,
    value.COMPLIANCE_PROVIDER_API_KEY,
  );

  if (value.NODE_ENV === 'production') {
    for (const [name, configured] of [
      ['payment', payment],
      ['custody', custody],
      ['price', price],
      ['compliance', compliance],
    ] as const) {
      if (!configured) throw new Error(`${name} provider configuration is required in production.`);
      assertProductionEndpoint(`${name.toUpperCase()}_PROVIDER_BASE_URL`, configured.baseUrl);
    }
  }

  return {
    environment: value.NODE_ENV,
    host: value.API_HOST,
    port: value.API_PORT,
    webOrigins: value.WEB_ORIGINS.split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter(Boolean),
    databaseUrl: value.SUPABASE_DB_URL,
    databaseSsl: value.SUPABASE_DB_SSL,
    tenantRef: value.ZORYQON_TENANT_REF,
    sessionEncryptionKey: value.SESSION_ENCRYPTION_KEY,
    sessionMaxAgeSeconds: value.SESSION_MAX_AGE_SECONDS,
    supabase: {
      url: value.SUPABASE_URL.replace(/\/$/, ''),
      publishableKey: value.SUPABASE_PUBLISHABLE_KEY,
      secretKey: value.SUPABASE_SECRET_KEY,
      jwtAudience: value.SUPABASE_JWT_AUDIENCE,
      storageBucket: value.SUPABASE_STORAGE_BUCKET,
    },
    providers: { payment, custody, price, compliance },
    logLevel: value.LOG_LEVEL,
    trustProxy: value.TRUST_PROXY === 'true',
    resolutionDisputeWindowHours: value.RESOLUTION_DISPUTE_WINDOW_HOURS,
  };
}

function provider(baseUrl?: string, apiKey?: string): ProviderConfig | null {
  if (!baseUrl && !apiKey) return null;
  if (!baseUrl || !apiKey) throw new Error('Provider URL and API key must be configured together.');
  return { baseUrl, apiKey };
}

function providerWithWebhook(
  baseUrl?: string,
  apiKey?: string,
  webhookSecret?: string,
): (ProviderConfig & { webhookSecret: string }) | null {
  if (!baseUrl && !apiKey && !webhookSecret) return null;
  if (!baseUrl || !apiKey || !webhookSecret || webhookSecret.length < 32) {
    throw new Error(
      'Payment provider URL, API key and a webhook secret of at least 32 characters must be configured together.',
    );
  }
  return { baseUrl, apiKey, webhookSecret };
}

function assertSupabaseConfiguration(value: z.infer<typeof EnvironmentSchema>): void {
  const projectUrl = new URL(value.SUPABASE_URL);
  if (!projectUrl.hostname.endsWith('.supabase.co') && value.NODE_ENV === 'production') {
    throw new Error('SUPABASE_URL must point to a Supabase project in production.');
  }
  if (/replace-|your-|example\.com|<project/i.test(value.SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY still contains a placeholder.');
  }
  if (/replace-|your-|example\.com|<project/i.test(value.SUPABASE_SECRET_KEY)) {
    throw new Error('SUPABASE_SECRET_KEY still contains a placeholder.');
  }
  if (/replace-|your-|localhost|<project/i.test(value.SUPABASE_DB_URL)) {
    throw new Error('SUPABASE_DB_URL must be the real Supabase connection string.');
  }
}

function assertProductionEndpoint(name: string, value: string): void {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost =
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  if (url.protocol !== 'https:' || privateHost || url.username || url.password) {
    throw new Error(`${name} must use a credential-free public HTTPS endpoint in production.`);
  }
}
