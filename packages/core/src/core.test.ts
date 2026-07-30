import { describe, expect, it } from 'vitest';
import {
  DeterministicOrderBook,
  DoubleEntryLedger,
  decideProductAccess,
  transitionMarket,
} from './index.js';

describe('Kynorix core invariants', () => {
  it('rejects an unbalanced ledger journal', () => {
    const ledger = new DoubleEntryLedger();
    ledger.createAccount({
      accountRef: 'treasury',
      tenantRef: 't1',
      ownerRef: null,
      asset: 'VSEK',
      accountType: 'treasury_cash',
      normalSide: 'debit',
    });
    ledger.createAccount({
      accountRef: 'customer',
      tenantRef: 't1',
      ownerRef: 'u1',
      asset: 'VSEK',
      accountType: 'customer_available',
      normalSide: 'credit',
    });
    expect(() =>
      ledger.post({
        tenantRef: 't1',
        transactionType: 'sandbox_grant',
        asset: 'VSEK',
        referenceType: 'grant',
        referenceRef: 'g1',
        idempotencyKey: 'grant-1',
        postings: [
          { accountRef: 'treasury', debitAtoms: 100n },
          { accountRef: 'customer', creditAtoms: 99n },
        ],
      }),
    ).toThrow(/Unbalanced/);
  });

  it('matches by price then time at the resting maker price', () => {
    const book = new DeterministicOrderBook('m1', 'yes');
    book.accept({
      orderRef: 'sell-1',
      userRef: 'maker-a',
      marketRef: 'm1',
      outcomeRef: 'yes',
      side: 'sell',
      priceAtoms: 55n,
      quantity: 10n,
      timeInForce: 'GTC',
      postOnly: true,
    });
    const result = book.accept({
      orderRef: 'buy-1',
      userRef: 'taker-b',
      marketRef: 'm1',
      outcomeRef: 'yes',
      side: 'buy',
      priceAtoms: 60n,
      quantity: 4n,
      timeInForce: 'GTC',
      postOnly: false,
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.priceAtoms).toBe(55n);
    expect(result.trades[0]?.quantity).toBe(4n);
    expect(book.snapshot().asks[0]?.quantity).toBe('6');
  });

  it('denies every real-money and five-minute product by server policy', () => {
    const subject = {
      country: 'SE',
      customerType: 'consumer' as const,
      kycLevel: 'identity_verified',
      channel: 'web' as const,
      selfExcluded: false,
      sanctionsHit: false,
    };
    expect(decideProductAccess('real_money_prediction', subject).decision).toBe('blocked_product');
    expect(decideProductAccess('five_minute_up_down', subject).decision).toBe('blocked_product');
    expect(decideProductAccess('virtual_prediction', subject).decision).toBe('allowed');
  });

  it('enforces the central market state machine', () => {
    expect(transitionMarket('draft', 'under_review')).toBe('under_review');
    expect(() => transitionMarket('draft', 'open')).toThrow(/Invalid market transition/);
  });
});
