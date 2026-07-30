'use client';

import type { Market, MarketHistoryPoint } from '@zoryqon/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatAtoms, formatDate, formatProbability, zoryqonApi } from '../lib/api';

export function MarketCard({ market }: { market: Market }) {
  const primary = market.outcomes[0];
  const secondary = market.outcomes[1];
  const [history, setHistory] = useState<MarketHistoryPoint[]>([]);

  useEffect(() => {
    if (!primary) return;
    void zoryqonApi
      .history(market.marketRef, primary.outcomeRef, '1D')
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [market.marketRef, primary]);

  return (
    <Link className="market-card" href={`/markets/${market.marketRef}`}>
      <div className="market-card-top">
        <span className="category">{market.category}</span>
        <span className={`market-status status-${market.status}`}>
          {market.status === 'open' && !market.tradingSuspended
            ? 'Live'
            : market.status.replaceAll('_', ' ')}
        </span>
      </div>
      <h3>{market.title}</h3>
      <div className="card-chart" aria-label="24-hour market price history">
        <Sparkline points={history} />
      </div>
      <div className="outcome-prices">
        <span className="yes-chip">
          {primary?.label ?? 'Yes'} <b>{formatProbability(primary?.lastPriceAtoms)}</b>
        </span>
        <span className="no-chip">
          {secondary?.label ?? 'No'} <b>{formatProbability(secondary?.lastPriceAtoms)}</b>
        </span>
      </div>
      <div className="market-stats">
        <span>
          Volume{' '}
          <b>{formatAtoms(market.volumeAtoms, market.collateralAsset, market.assetDecimals)}</b>
        </span>
        <span>
          Liquidity{' '}
          <b>{formatAtoms(market.liquidityAtoms, market.collateralAsset, market.assetDecimals)}</b>
        </span>
        <span>
          Closes <b>{formatDate(market.closesAt)}</b>
        </span>
      </div>
    </Link>
  );
}

function Sparkline({ points }: { points: MarketHistoryPoint[] }) {
  if (points.length < 2)
    return <div className="chart-empty">History begins after the first trade.</div>;
  const values = points.map((point) => Number(point.priceAtoms));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 36 - ((value - min) / range) * 32;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img">
      <path d={path} />
    </svg>
  );
}
