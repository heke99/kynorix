export type LedgerAccountType =
  | 'customer_available'
  | 'customer_locked'
  | 'customer_pending_deposit'
  | 'customer_pending_withdrawal'
  | 'customer_asset_available'
  | 'customer_asset_locked'
  | 'collateral_locked'
  | 'trade_clearing'
  | 'settlement_payable'
  | 'platform_fee_revenue'
  | 'partner_fee_payable'
  | 'network_fee_payable'
  | 'refund_payable'
  | 'chargeback_reserve'
  | 'treasury_cash'
  | 'treasury_crypto'
  | 'reconciliation_difference';

export interface Posting {
  accountRef: string;
  debitAtoms?: bigint;
  creditAtoms?: bigint;
}

export function assertBalancedPostings(postings: readonly Posting[]): void {
  if (postings.length < 2) throw new Error('A journal requires at least two entries.');
  let debits = 0n;
  let credits = 0n;
  for (const posting of postings) {
    const debit = posting.debitAtoms ?? 0n;
    const credit = posting.creditAtoms ?? 0n;
    if (debit < 0n || credit < 0n || debit > 0n === credit > 0n) {
      throw new Error('Each entry must contain exactly one positive debit or credit.');
    }
    debits += debit;
    credits += credit;
  }
  if (debits !== credits) throw new Error(`Unbalanced journal: ${debits} != ${credits}.`);
}

export function signedAccountDelta(
  normalSide: 'debit' | 'credit',
  debitAtoms: bigint,
  creditAtoms: bigint,
): bigint {
  return normalSide === 'debit' ? debitAtoms - creditAtoms : creditAtoms - debitAtoms;
}
