import { z } from 'zod';

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().max(65_535).default(4000),
  WEB_ORIGINS: z.string().min(1),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('require'),
  REDIS_URL: z.string().url(),
  EVENT_BROKER_URL: z.string().min(1),
  OBJECT_STORAGE_ENDPOINT: z.string().url(),
  OBJECT_STORAGE_BUCKET: z.string().min(1),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_REDIRECT_URI: z.string().url(),
  SESSION_ENCRYPTION_KEY: z.string().min(43),
  KYNORIX_TENANT_REF: z.string().min(1),
  PAYMENT_PROVIDER_BASE_URL: z.string().url(),
  PAYMENT_PROVIDER_API_KEY: z.string().min(1),
  PAYMENT_PROVIDER_WEBHOOK_SECRET: z.string().min(32),
  CUSTODY_PROVIDER_BASE_URL: z.string().url(),
  CUSTODY_PROVIDER_API_KEY: z.string().min(1),
  PRICE_PROVIDER_BASE_URL: z.string().url(),
  PRICE_PROVIDER_API_KEY: z.string().min(1),
  COMPLIANCE_PROVIDER_BASE_URL: z.string().url(),
  COMPLIANCE_PROVIDER_API_KEY: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

export interface ApiConfig {
  environment: 'development' | 'test' | 'staging' | 'production';
  host: string;
  port: number;
  webOrigins: string[];
  databaseUrl: string;
  databaseSsl: 'disable' | 'require' | 'verify-full';
  redisUrl: string;
  eventBrokerUrl: string;
  objectStorageEndpoint: string;
  objectStorageBucket: string;
  tenantRef: string;
  oidc: {
    issuer: string;
    audience: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  sessionEncryptionKey: string;
  providers: {
    payment: ProviderConfig & { webhookSecret: string };
    custody: ProviderConfig;
    price: ProviderConfig;
    compliance: ProviderConfig;
  };
  logLevel: string;
  trustProxy: boolean;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid or missing production configuration: ${missing}`);
  }
  const value = parsed.data;
  return {
    environment: value.NODE_ENV,
    host: value.API_HOST,
    port: value.API_PORT,
    webOrigins: value.WEB_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    databaseUrl: value.DATABASE_URL,
    databaseSsl: value.DATABASE_SSL,
    redisUrl: value.REDIS_URL,
    eventBrokerUrl: value.EVENT_BROKER_URL,
    objectStorageEndpoint: value.OBJECT_STORAGE_ENDPOINT,
    objectStorageBucket: value.OBJECT_STORAGE_BUCKET,
    tenantRef: value.KYNORIX_TENANT_REF,
    oidc: {
      issuer: value.OIDC_ISSUER,
      audience: value.OIDC_AUDIENCE,
      clientId: value.OIDC_CLIENT_ID,
      clientSecret: value.OIDC_CLIENT_SECRET,
      redirectUri: value.OIDC_REDIRECT_URI,
    },
    sessionEncryptionKey: value.SESSION_ENCRYPTION_KEY,
    providers: {
      payment: {
        baseUrl: value.PAYMENT_PROVIDER_BASE_URL,
        apiKey: value.PAYMENT_PROVIDER_API_KEY,
        webhookSecret: value.PAYMENT_PROVIDER_WEBHOOK_SECRET,
      },
      custody: {
        baseUrl: value.CUSTODY_PROVIDER_BASE_URL,
        apiKey: value.CUSTODY_PROVIDER_API_KEY,
      },
      price: {
        baseUrl: value.PRICE_PROVIDER_BASE_URL,
        apiKey: value.PRICE_PROVIDER_API_KEY,
      },
      compliance: {
        baseUrl: value.COMPLIANCE_PROVIDER_BASE_URL,
        apiKey: value.COMPLIANCE_PROVIDER_API_KEY,
      },
    },
    logLevel: value.LOG_LEVEL,
    trustProxy: value.TRUST_PROXY === 'true',
  };
}
