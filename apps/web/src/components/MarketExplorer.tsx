'use client';

import type { Market } from '@kynorix/contracts';
import { useEffect, useMemo, useState } from 'react';
import { kynorixApi } from '../lib/api';
import { MarketCard } from './MarketCard';

export function MarketExplorer() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Alla');

  useEffect(() => {
    void kynorixApi
      .markets()
      .then(setMarkets)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Marknaderna kunde inte hämtas'),
      )
      .finally(() => setLoading(false));
  }, []);

  const categories = useMemo(
    () => ['Alla', ...new Set(markets.map((market) => market.category))],
    [markets],
  );
  const filtered = markets.filter((market) => {
    const matchesCategory = category === 'Alla' || market.category === category;
    const haystack = `${market.title} ${market.question}`.toLowerCase();
    return matchesCategory && haystack.includes(query.toLowerCase());
  });

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <span className="kicker">Kollektiv intelligens, mätbara utfall</span>
          <h1>Se vad marknaden tror händer härnäst.</h1>
          <p>
            Handla med virtuella medel på tydligt definierade händelser. Varje marknad har öppna
            regler, källa och granskningsbar resolution.
          </p>
          <div className="hero-proof">
            <span>
              <b>100 %</b> virtuellt kapital
            </span>
            <span>
              <b>2-personers</b> resolution
            </span>
            <span>
              <b>0</b> riktiga insättningar
            </span>
          </div>
        </div>
        <div className="signal-card" aria-label="Kynorix sandbox status">
          <div className="signal-orbit">
            <div className="signal-core">K</div>
          </div>
          <div>
            <span className="eyebrow">Systemstatus</span>
            <strong>Sandbox är aktiv</strong>
            <p>Real-money och korttidsprodukter är spärrade i serverpolicyn.</p>
          </div>
        </div>
      </section>

      <section className="market-section">
        <div className="section-heading">
          <div>
            <span className="kicker">Live i sandbox</span>
            <h2>Utforska marknader</h2>
          </div>
          <label className="search">
            <span className="sr-only">Sök marknader</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Sök händelse eller ämne"
            />
          </label>
        </div>
        <div className="category-row">
          {categories.map((value) => (
            <button
              key={value}
              className={value === category ? 'category-button active' : 'category-button'}
              onClick={() => setCategory(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>
        {loading && <div className="state-card">Hämtar marknader…</div>}
        {error && (
          <div className="state-card error">
            <strong>API:t går inte att nå.</strong>
            <span>{error}. Starta projektet med npm run dev.</span>
          </div>
        )}
        {!loading && !error && (
          <div className="market-grid">
            {filtered.map((market) => (
              <MarketCard key={market.marketRef} market={market} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
