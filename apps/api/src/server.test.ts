import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('production configuration', () => {
  it('fails closed when mandatory infrastructure or provider settings are absent', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      /Invalid or missing production configuration/,
    );
  });

  it('accepts a complete explicit configuration', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: '4000',
      WEB_ORIGINS: 'https://app.example.test',
      DATABASE_URL: 'postgresql://user:password@database.example.test:5432/zoryqon',
      DATABASE_SSL: 'require',
      REDIS_URL: 'redis://redis.example.test:6379',
      EVENT_BROKER_URL: 'tcp://broker.example.test:9092',
      OBJECT_STORAGE_ENDPOINT: 'https://objects.example.test',
      OBJECT_STORAGE_BUCKET: 'zoryqon-test',
      OIDC_ISSUER: 'https://identity.example.test',
      OIDC_AUDIENCE: 'zoryqon-api',
      OIDC_CLIENT_ID: 'zoryqon-web',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/callback',
      SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
      ZORYQON_TENANT_REF: 'tenant_test',
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
    expect(config.environment).toBe('test');
    expect(config.tenantRef).toBe('tenant_test');
  });
});
