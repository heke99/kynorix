import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

const config = {
  host: '127.0.0.1',
  port: 4000,
  webOrigins: ['http://localhost:3000'],
  sandboxMode: true as const,
};

describe('Kynorix sandbox API', () => {
  it('exposes only the approved sandbox capability set', async () => {
    const app = await buildServer(config);
    const response = await app.inject({ method: 'GET', url: '/v1/system/capabilities' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.enabled).toContain('virtual_prediction');
    expect(response.json().data.denied).toContain('five_minute_up_down');
    await app.close();
  });

  it('places an idempotent order and never charges twice', async () => {
    const app = await buildServer(config);
    const payload = {
      marketRef: 'mkt_riksbank_2026',
      outcomeRef: 'mkt_riksbank_2026_yes',
      side: 'buy',
      type: 'limit',
      priceAtoms: '55',
      quantity: '10',
      timeInForce: 'GTC',
      postOnly: false,
      idempotencyKey: 'api-test-order-0001',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { 'x-kynorix-user': 'demo-alex' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { 'x-kynorix-user': 'demo-alex' },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().data.orderRef).toBe(second.json().data.orderRef);
    const balance = await app.inject({
      method: 'GET',
      url: '/v1/balances',
      headers: { 'x-kynorix-user': 'demo-alex' },
    });
    expect(balance.json().data[0]).toEqual({
      asset: 'VSEK',
      availableAtoms: '999448',
      lockedAtoms: '0',
    });
    await app.close();
  });

  it('requires two distinct officers before settlement', async () => {
    const app = await buildServer(config);
    const close = await app.inject({
      method: 'POST',
      url: '/v1/admin/markets/mkt_riksbank_2026/close-for-resolution',
      headers: { 'x-kynorix-admin': 'officer-livia' },
      payload: {},
    });
    expect(close.json().data.status).toBe('resolution_pending');
    const proposal = await app.inject({
      method: 'POST',
      url: '/v1/admin/markets/mkt_riksbank_2026/resolutions',
      headers: { 'x-kynorix-admin': 'officer-livia' },
      payload: {
        outcomeRef: 'mkt_riksbank_2026_yes',
        reason: 'Official sandbox evidence supports the selected outcome.',
        evidence: [
          {
            source: 'https://www.riksbank.se/',
            capturedAt: new Date().toISOString(),
            contentHash: 'a'.repeat(64),
            notes: 'Evidence captured and retained for independent sandbox review.',
          },
        ],
      },
    });
    expect(proposal.statusCode).toBe(201);
    const proposalRef = proposal.json().data.proposalRef as string;
    const sameOfficer = await app.inject({
      method: 'POST',
      url: `/v1/admin/resolutions/${proposalRef}/approve`,
      headers: { 'x-kynorix-admin': 'officer-livia' },
      payload: {},
    });
    expect(sameOfficer.statusCode).toBe(400);
    const independentOfficer = await app.inject({
      method: 'POST',
      url: `/v1/admin/resolutions/${proposalRef}/approve`,
      headers: { 'x-kynorix-admin': 'officer-noah' },
      payload: {},
    });
    expect(independentOfficer.statusCode).toBe(200);
    expect(independentOfficer.json().data.market.status).toBe('settled');
    await app.close();
  });
});
