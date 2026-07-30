'use client';

import type { Market } from '@zoryqon/contracts';
import { useCallback, useEffect, useState } from 'react';
import { zoryqonApi } from '../lib/api';
import { MarketCard } from './MarketCard';

export function MarketExplorer({
  initialCategory = '',
  initialQuery = '',
}: {
  initialCategory?: string;
  initialQuery?: string;
}) {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [categories, setCategories] = useState<Array<{ categoryRef: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState(initialCategory);
  const [sort, setSort] = useState('trending');
  const [cursor, setCursor] = useState<string | null>(null);

  const load = useCallback(
    async (append = false) => {
      append ? setLoadingMore(true) : setLoading(true);
      setError('');
      try {
        const filters: {
          query?: string;
          category?: string;
          sort?: string;
          cursor?: string;
          limit?: number;
        } = { sort, limit: 24 };
        if (query) filters.query = query;
        if (category) filters.category = category;
        if (append && cursor) filters.cursor = cursor;
        const result = await zoryqonApi.markets(filters);
        setMarkets((current) => (append ? [...current, ...result.items] : result.items));
        setCursor(result.nextCursor);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Markets could not be loaded.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [category, cursor, query, sort],
  );

  useEffect(() => {
    void zoryqonApi
      .categories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(false), 250);
    return () => clearTimeout(timer);
  }, [category, query, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="market-section catalogue">
      <div className="section-heading catalogue-heading">
        <div>
          <span className="kicker">Live markets</span>
          <h1>What will happen next?</h1>
        </div>
        <label className="search">
          <span className="sr-only">Search markets</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search markets"
          />
        </label>
      </div>
      <div className="catalogue-controls">
        <div className="category-row">
          <button
            className={!category ? 'category-button active' : 'category-button'}
            onClick={() => setCategory('')}
          >
            All
          </button>
          {categories.map((item) => (
            <button
              key={item.categoryRef}
              className={
                item.categoryRef === category ? 'category-button active' : 'category-button'
              }
              onClick={() => setCategory(item.categoryRef)}
            >
              {item.name}
            </button>
          ))}
        </div>
        <label className="sort-control">
          <span>Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="trending">Trending</option>
            <option value="volume">Volume</option>
            <option value="liquidity">Liquidity</option>
            <option value="newest">Newest</option>
            <option value="ending_soon">Ending soon</option>
          </select>
        </label>
      </div>
      {loading && <div className="state-card">Loading live markets…</div>}
      {error && (
        <div className="state-card error">
          <strong>Markets unavailable</strong>
          <span>{error}</span>
        </div>
      )}
      {!loading && !error && markets.length === 0 && (
        <div className="state-card">No markets match these filters.</div>
      )}
      {!loading && !error && (
        <>
          <div className="market-grid">
            {markets.map((market) => (
              <MarketCard key={market.marketRef} market={market} />
            ))}
          </div>
          {cursor && (
            <button className="load-more" disabled={loadingMore} onClick={() => void load(true)}>
              {loadingMore ? 'Loading…' : 'Load more markets'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
