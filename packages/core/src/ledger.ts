import { externalRef } from './id.js';

export type LedgerAccountType =
  | 'customer_available'
  | 'customer_locked'
  | 'customer_pending_deposit'
  | 'customer_pending_withdrawal'
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

export interface LedgerAccount {
  accountRef: string;
  tenantRef: string;
  ownerRef: string | null;
  asset: string;
  accountType: LedgerAccountType;
  normalSide: 'debit' | 'credit';
}

export interface LedgerEntry {
  entryRef: string;
  accountRef: string;
  debitAtoms: bigint;
  creditAtoms: bigint;
}

export interface LedgerJournal {
  journalRef: string;
  tenantRef: string;
  transactionType: string;
  asset: string;
  referenceType: string;
  referenceRef: string;
  idempotencyKey: string;
  createdAt: string;
  effectiveAt: string;
  status: 'posted';
  entries: LedgerEntry[];
}

export interface Posting {
  accountRef: string;
  debitAtoms?: bigint;
  creditAtoms?: bigint;
}

export class DoubleEntryLedger {
  private readonly accounts = new Map<string, LedgerAccount>();
  private readonly journals = new Map<string, LedgerJournal>();
  private readonly idempotency = new Map<string, string>();
  private readonly balances = new Map<string, bigint>();

  createAccount(account: LedgerAccount): void {
    if (this.accounts.has(account.accountRef)) {
      throw new Error(`Ledger account already exists: ${account.accountRef}`);
    }
    this.accounts.set(account.accountRef, account);
    this.balances.set(account.accountRef, 0n);
  }

  post(input: {
    tenantRef: string;
    transactionType: string;
    asset: string;
    referenceType: string;
    referenceRef: string;
    idempotencyKey: string;
    postings: Posting[];
    effectiveAt?: string;
  }): LedgerJournal {
    const existingRef = this.idempotency.get(input.idempotencyKey);
    if (existingRef) return this.journals.get(existingRef)!;

    if (input.postings.length < 2) throw new Error('A journal requires at least two entries');
    let totalDebit = 0n;
    let totalCredit = 0n;
    const entries: LedgerEntry[] = input.postings.map((posting) => {
      const account = this.accounts.get(posting.accountRef);
      if (!account) throw new Error(`Unknown ledger account: ${posting.accountRef}`);
      if (account.tenantRef !== input.tenantRef) throw new Error('Cross-tenant posting denied');
      if (account.asset !== input.asset) throw new Error('Cross-asset journal denied');
      const debitAtoms = posting.debitAtoms ?? 0n;
      const creditAtoms = posting.creditAtoms ?? 0n;
      if (debitAtoms < 0n || creditAtoms < 0n || debitAtoms > 0n === creditAtoms > 0n) {
        throw new Error('Each entry must have exactly one positive debit or credit');
      }
      totalDebit += debitAtoms;
      totalCredit += creditAtoms;
      return {
        entryRef: externalRef('lent'),
        accountRef: posting.accountRef,
        debitAtoms,
        creditAtoms,
      };
    });

    if (totalDebit !== totalCredit) {
      throw new Error(`Unbalanced journal: debit ${totalDebit} != credit ${totalCredit}`);
    }

    const nextBalances = new Map<string, bigint>();
    for (const entry of entries) {
      const account = this.accounts.get(entry.accountRef)!;
      const current = nextBalances.get(entry.accountRef) ?? this.balance(entry.accountRef);
      const delta =
        account.normalSide === 'debit'
          ? entry.debitAtoms - entry.creditAtoms
          : entry.creditAtoms - entry.debitAtoms;
      const next = current + delta;
      if (
        next < 0n &&
        (account.accountType === 'customer_available' ||
          account.accountType === 'customer_locked' ||
          account.accountType === 'collateral_locked')
      ) {
        throw new Error(`Negative protected balance denied: ${account.accountRef}`);
      }
      nextBalances.set(entry.accountRef, next);
    }

    const createdAt = new Date().toISOString();
    const journal: LedgerJournal = {
      journalRef: externalRef('ljrn'),
      tenantRef: input.tenantRef,
      transactionType: input.transactionType,
      asset: input.asset,
      referenceType: input.referenceType,
      referenceRef: input.referenceRef,
      idempotencyKey: input.idempotencyKey,
      createdAt,
      effectiveAt: input.effectiveAt ?? createdAt,
      status: 'posted',
      entries,
    };
    for (const [accountRef, value] of nextBalances) this.balances.set(accountRef, value);
    this.journals.set(journal.journalRef, journal);
    this.idempotency.set(input.idempotencyKey, journal.journalRef);
    return journal;
  }

  balance(accountRef: string): bigint {
    if (!this.accounts.has(accountRef)) throw new Error(`Unknown ledger account: ${accountRef}`);
    return this.balances.get(accountRef) ?? 0n;
  }

  getAccount(accountRef: string): LedgerAccount | undefined {
    return this.accounts.get(accountRef);
  }

  listJournals(tenantRef: string, ownerRef?: string): LedgerJournal[] {
    return [...this.journals.values()].filter((journal) => {
      if (journal.tenantRef !== tenantRef) return false;
      if (!ownerRef) return true;
      return journal.entries.some(
        (entry) => this.accounts.get(entry.accountRef)?.ownerRef === ownerRef,
      );
    });
  }

  assertBalanced(): void {
    for (const journal of this.journals.values()) {
      const debit = journal.entries.reduce((sum, entry) => sum + entry.debitAtoms, 0n);
      const credit = journal.entries.reduce((sum, entry) => sum + entry.creditAtoms, 0n);
      if (debit !== credit) throw new Error(`Journal ${journal.journalRef} is unbalanced`);
    }
  }
}
