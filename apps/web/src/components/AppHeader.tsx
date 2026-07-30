'use client';

import type { AuthenticatedUser, Balance } from '@zoryqon/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatAtoms, zoryqonApi } from '../lib/api';

export function AppHeader() {
  const pathname = usePathname();
  const [user, setUser] = useState<AuthenticatedUser>();
  const [balance, setBalance] = useState<Balance>();

  useEffect(() => {
    void zoryqonApi
      .me()
      .then(async (nextUser) => {
        setUser(nextUser);
        setBalance((await zoryqonApi.balances())[0]);
      })
      .catch(() => {
        setUser(undefined);
        setBalance(undefined);
      });
  }, [pathname]);

  return (
    <header className="app-header">
      <Link className="brand" href="/" aria-label="Zoryqon home">
        <span className="brand-mark" aria-hidden="true">
          K
        </span>
        <span>zoryqon</span>
      </Link>
      <nav aria-label="Primary navigation">
        <Link href="/markets">Markets</Link>
        <Link href="/categories">Categories</Link>
        {user && <Link href="/portfolio">Portfolio</Link>}
        {user && <Link href="/orders">Orders</Link>}
      </nav>
      <div className="header-actions">
        {user ? (
          <>
            <Link className="balance-link" href="/wallet">
              {balance
                ? formatAtoms(balance.availableAtoms, balance.asset, balance.decimals)
                : 'Wallet'}
            </Link>
            <Link className="secondary-button" href="/wallet/withdraw">
              Withdraw
            </Link>
            <Link className="primary-button compact" href="/wallet/deposit">
              Deposit
            </Link>
            <Link className="avatar" href="/settings" title={user.displayName}>
              {user.displayName.slice(0, 1).toUpperCase()}
            </Link>
          </>
        ) : (
          <>
            <a className="login-link" href={zoryqonApi.loginUrl(pathname)}>
              Log in
            </a>
            <a className="primary-button compact" href={zoryqonApi.loginUrl('/verification')}>
              Sign up
            </a>
          </>
        )}
      </div>
    </header>
  );
}
