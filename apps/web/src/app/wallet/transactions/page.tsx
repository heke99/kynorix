'use client';

import type { Deposit, Withdrawal } from '@kynorix/contracts';
import { useEffect, useState } from 'react';
import { formatDate, kynorixApi } from '../../../lib/api';

export default function TransactionsPage() {
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  useEffect(() => {
    void Promise.all([kynorixApi.deposits(), kynorixApi.withdrawals()]).then(([a, b]) => {
      setDeposits(a);
      setWithdrawals(b);
    });
  }, []);
  const rows = [
    ...deposits.map((value) => ({
      ref: value.depositRef,
      type: 'Deposit',
      asset: value.asset,
      amount: value.amountAtoms,
      status: value.status,
      createdAt: value.createdAt,
    })),
    ...withdrawals.map((value) => ({
      ref: value.withdrawalRef,
      type: 'Withdrawal',
      asset: value.asset,
      amount: value.amountAtoms,
      status: value.status,
      createdAt: value.createdAt,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="portfolio-page">
      <div className="page-heading">
        <span className="kicker">Account activity</span>
        <h1>Transactions</h1>
      </div>
      <section className="table-card">
        <div className="responsive-table">
          <div className="table-row table-head">
            <span>Type</span>
            <span>Reference</span>
            <span>Asset</span>
            <span>Amount</span>
            <span>Status</span>
            <span>Created</span>
          </div>
          {rows.map((row) => (
            <div className="table-row" key={row.ref}>
              <span>{row.type}</span>
              <span>{row.ref}</span>
              <span>{row.asset}</span>
              <span>{row.amount}</span>
              <span>{row.status.replaceAll('_', ' ')}</span>
              <span>{formatDate(row.createdAt)}</span>
            </div>
          ))}
          {rows.length === 0 && <div className="empty-row">No transactions found.</div>}
        </div>
      </section>
    </div>
  );
}
