'use client';

import type { Position } from '@zoryqon/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatAtoms, zoryqonApi } from '../../lib/api';

export default function PortfolioPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void zoryqonApi
      .positions()
      .then(setPositions)
      .catch((cause: unknown) => {
        const value = cause as Error & { status?: number };
        if (value.status === 401) window.location.assign(zoryqonApi.loginUrl('/portfolio'));
        else setError(value.message);
      });
  }, []);
  const unrealized = positions.reduce((sum, value) => sum + BigInt(value.unrealizedPnlAtoms), 0n);
  const realized = positions.reduce((sum, value) => sum + BigInt(value.realizedPnlAtoms), 0n);
  const asset = 'USD';
  return (
    <div className="portfolio-page">
      <div className="page-heading">
        <span className="kicker">Positions and performance</span>
        <h1>Portfolio</h1>
        <p>Values are calculated from confirmed positions and the latest stored market price.</p>
      </div>
      {error && <div className="state-card error">{error}</div>}
      <div className="summary-grid">
        <article>
          <span>Active positions</span>
          <strong>{positions.filter((value) => value.marketStatus === 'open').length}</strong>
        </article>
        <article>
          <span>Unrealized P&amp;L</span>
          <strong>{formatAtoms(unrealized.toString(), asset)}</strong>
        </article>
        <article>
          <span>Realized P&amp;L</span>
          <strong>{formatAtoms(realized.toString(), asset)}</strong>
        </article>
        <article>
          <span>Markets</span>
          <strong>{new Set(positions.map((value) => value.marketRef)).size}</strong>
        </article>
      </div>
      <section className="table-card">
        <div className="card-heading">
          <h2>Positions</h2>
          <span>Ledger-backed</span>
        </div>
        <div className="responsive-table">
          <div className="table-row table-head">
            <span>Market</span>
            <span>Outcome</span>
            <span>Quantity</span>
            <span>Entry</span>
            <span>Current</span>
            <span>P&amp;L</span>
          </div>
          {positions.map((position) => (
            <Link
              className="table-row"
              href={`/markets/${position.marketRef}`}
              key={`${position.marketRef}:${position.outcomeRef}`}
            >
              <span>{position.marketTitle}</span>
              <span>{position.outcomeLabel}</span>
              <span>
                {position.availableQuantity} + {position.lockedQuantity} locked
              </span>
              <span>{position.averageEntryPriceAtoms}</span>
              <span>{position.currentPriceAtoms ?? '—'}</span>
              <span>{formatAtoms(position.unrealizedPnlAtoms, asset)}</span>
            </Link>
          ))}
          {positions.length === 0 && (
            <div className="empty-row">You do not have any positions yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}
