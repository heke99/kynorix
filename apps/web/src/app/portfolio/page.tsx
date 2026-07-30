'use client';

import type { Balance, Order, Position } from '@kynorix/contracts';
import { useEffect, useState } from 'react';
import { formatAtoms, kynorixApi } from '../../lib/api';

export default function PortfolioPage() {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([kynorixApi.balances(), kynorixApi.positions(), kynorixApi.orders()])
      .then(([nextBalances, nextPositions, nextOrders]) => {
        setBalances(nextBalances);
        setPositions(nextPositions);
        setOrders(nextOrders);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Kunde inte hämta data'),
      );
  }, []);

  return (
    <div className="portfolio-page">
      <div className="page-heading">
        <span className="kicker">Demoidentitet · Alex</span>
        <h1>Portfölj</h1>
        <p>Alla belopp och positioner är virtuella och saknar kontantvärde.</p>
      </div>
      {error && <div className="state-card error">{error}</div>}
      <div className="summary-grid">
        <article>
          <span>Tillgängligt</span>
          <strong>{formatAtoms(balances[0]?.availableAtoms ?? '0')}</strong>
        </article>
        <article>
          <span>Låst i order</span>
          <strong>{formatAtoms(balances[0]?.lockedAtoms ?? '0')}</strong>
        </article>
        <article>
          <span>Aktiva positioner</span>
          <strong>{positions.length}</strong>
        </article>
        <article>
          <span>Öppna order</span>
          <strong>
            {
              orders.filter(
                (order) => order.status === 'open' || order.status === 'partially_filled',
              ).length
            }
          </strong>
        </article>
      </div>
      <section className="table-card">
        <div className="card-heading">
          <h2>Positioner</h2>
          <span>Återskapningsbara från fills</span>
        </div>
        <div className="responsive-table">
          <div className="table-row table-head">
            <span>Marknad</span>
            <span>Utfall</span>
            <span>Tillgängligt</span>
            <span>Låst</span>
            <span>Snittpris</span>
            <span>Avgifter</span>
          </div>
          {positions.map((position) => (
            <div className="table-row" key={`${position.marketRef}:${position.outcomeRef}`}>
              <span>{position.marketRef}</span>
              <span>{position.outcomeRef.endsWith('yes') ? 'JA' : 'NEJ'}</span>
              <span>{position.availableQuantity}</span>
              <span>{position.lockedQuantity}</span>
              <span>{position.averageEntryPriceAtoms}%</span>
              <span>{formatAtoms(position.feesPaidAtoms)}</span>
            </div>
          ))}
          {positions.length === 0 && <div className="empty-row">Du har inga positioner ännu.</div>}
        </div>
      </section>
    </div>
  );
}
