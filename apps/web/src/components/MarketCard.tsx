'use client';

import type { Market } from '@kynorix/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatProbability, kynorixApi } from '../lib/api';

export function MarketCard({ market }: { market: Market }) {
  const [yesPrice, setYesPrice] = useState<string>();

  useEffect(() => {
    void kynorixApi
      .orderbook(market.marketRef, market.outcomes[0]!.outcomeRef)
      .then((book) => setYesPrice(book.asks[0]?.priceAtoms ?? book.bids[0]?.priceAtoms))
      .catch(() => setYesPrice(undefined));
  }, [market]);

  return (
    <Link className="market-card" href={`/markets/${market.marketRef}`}>
      <div className="market-card-top">
        <span className={`category category-${market.category.toLowerCase()}`}>
          {market.category}
        </span>
        <span className="market-status">{market.status === 'open' ? 'Öppen' : market.status}</span>
      </div>
      <h3>{market.title}</h3>
      <p>{market.question}</p>
      <div className="market-card-bottom">
        <div>
          <span className="eyebrow">Marknadens JA-pris</span>
          <strong className="probability">{formatProbability(yesPrice)}</strong>
        </div>
        <div className="outcome-chips" aria-label="Utfall">
          <span className="yes-chip">JA</span>
          <span className="no-chip">NEJ</span>
        </div>
      </div>
    </Link>
  );
}
