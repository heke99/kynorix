import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '4000',
  WEB_ORIGINS: 'https://app.example.test',
  SUPABASE_URL: 'https://abcdefghijklm.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key',
  SUPABASE_SECRET_KEY: 'sb_secret_test_key',
  SUPABASE_DB_URL:
    'postgresql://postgres.abcdefghijklm:password@aws-0-eu-north-1.pooler.supabase.com:5432/postgres',
  SUPABASE_DB_SSL: 'require',
  SUPABASE_JWT_AUDIENCE: 'authenticated',
  SUPABASE_STORAGE_BUCKET: 'zoryqon-private',
  SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
  ZORYQON_TENANT_REF: 'zoryqon',
};

describe('Supabase configuration', () => {
  it('fails closed when mandatory Supabase settings are absent', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      /Invalid or missing API configuration/,
    );
  });

  it('accepts Supabase without external development providers', () => {
    const config = loadConfig(base);
    expect(config.environment).toBe('test');
    expect(config.tenantRef).toBe('zoryqon');
    expect(config.providers.price).toBeNull();
  });

  it('requires all production providers', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /provider configuration is required in production/,
    );
  });

  it('accepts complete production provider settings', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      PAYMENT_PROVIDER_BASE_URL: 'https://payments.example.test',
      PAYMENT_PROVIDER_API_KEY: 'payment-key',
      PAYMENT_PROVIDER_WEBHOOK_SECRET: 'a'.repeat(32),
      CUSTODY_PROVIDER_BASE_URL: 'https://custody.example.test',
      CUSTODY_PROVIDER_API_KEY: 'custody-key',
      PRICE_PROVIDER_BASE_URL: 'https://prices.example.test',
      PRICE_PROVIDER_API_KEY: 'price-key',
      COMPLIANCE_PROVIDER_BASE_URL: 'https://compliance.example.test',
      COMPLIANCE_PROVIDER_API_KEY: 'compliance-key',
    });
    expect(config.providers.payment).not.toBeNull();
  });
});
