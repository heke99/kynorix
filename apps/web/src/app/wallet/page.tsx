'use client';

import type { Balance } from '@kynorix/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatAtoms, kynorixApi } from '../../lib/api';

export default function WalletPage() {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void kynorixApi
      .balances()
      .then(setBalances)
      .catch((cause: unknown) => {
        const value = cause as Error & { status?: number };
        if (value.status === 401) window.location.assign(kynorixApi.loginUrl('/wallet'));
        else setError(value.message);
      });
  }, []);
  return (
    <div className="portfolio-page">
      <div className="page-heading">
        <span className="kicker">Funds and assets</span>
        <h1>Wallet</h1>
        <p>Balances are reproduced from the double-entry ledger.</p>
      </div>
      {error && <div className="state-card error">{error}</div>}
      <div className="wallet-actions">
        <Link className="primary-button" href="/wallet/deposit">
          Deposit
        </Link>
        <Link className="secondary-button" href="/wallet/withdraw">
          Withdraw
        </Link>
        <Link href="/wallet/transactions">Transaction history</Link>
      </div>
      <div className="summary-grid">
        {balances.map((balance) => (
          <article key={balance.asset}>
            <span>{balance.asset}</span>
            <strong>{formatAtoms(balance.availableAtoms, balance.asset, balance.decimals)}</strong>
            <small>
              {formatAtoms(balance.lockedAtoms, balance.asset, balance.decimals)} locked ·{' '}
              {formatAtoms(balance.pendingDepositAtoms, balance.asset, balance.decimals)} pending
              deposit
            </small>
          </article>
        ))}
        {balances.length === 0 && (
          <div className="state-card">No enabled wallet assets are available.</div>
        )}
      </div>
    </div>
  );
}
