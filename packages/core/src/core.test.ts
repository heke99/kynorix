import { describe, expect, it } from 'vitest';
import {
  DeterministicOrderBook,
  assertBalancedPostings,
  decideProductAccess,
  transitionMarket,
} from './index.js';

describe('Kynorix core invariants', () => {
  it('rejects an unbalanced ledger journal', () => {
    expect(() =>
      assertBalancedPostings([
        { accountRef: 'treasury', debitAtoms: 100n },
        { accountRef: 'customer', creditAtoms: 99n },
      ]),
    ).toThrow(/Unbalanced/);
  });

  it('matches by price then time at the resting maker price', () => {
    const book = new DeterministicOrderBook('market-1', 'yes');
    book.accept({
      orderRef: 'sell-1',
      userRef: 'maker-1',
      marketRef: 'market-1',
      outcomeRef: 'yes',
      side: 'sell',
      priceAtoms: 55n,
      quantity: 10n,
      timeInForce: 'GTC',
      postOnly: true,
    });
    const result = book.accept({
      orderRef: 'buy-1',
      userRef: 'taker-1',
      marketRef: 'market-1',
      outcomeRef: 'yes',
      side: 'buy',
      priceAtoms: 60n,
      quantity: 4n,
      timeInForce: 'GTC',
      postOnly: false,
    });
    expect(result.trades[0]?.priceAtoms).toBe(55n);
    expect(result.trades[0]?.quantity).toBe(4n);
  });

  it('enforces a persisted product policy', () => {
    const policy = {
      productRef: 'event-contract-v1',
      productType: 'event_contract' as const,
      status: 'approved' as const,
      targetCustomerTypes: ['customer'],
      permittedCountries: ['US'],
      blockedCountries: [],
      requiredKycLevel: 'basic',
      allowedChannels: ['web' as const],
      positionLimitAtoms: 1000n,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    };
    expect(
      decideProductAccess(
        policy,
        {
          country: 'US',
          customerType: 'customer',
          kycLevel: 'basic',
          channel: 'web',
          selfExcluded: false,
          sanctionsHit: false,
          accountRestricted: false,
        },
        new Date('2026-07-30T00:00:00.000Z'),
      ).decision,
    ).toBe('allowed');
  });

  it('enforces the central market state machine', () => {
    expect(transitionMarket('draft', 'under_review')).toBe('under_review');
    expect(() => transitionMarket('draft', 'open')).toThrow(/Invalid market transition/);
  });
});
