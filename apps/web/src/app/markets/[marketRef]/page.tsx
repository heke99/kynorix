'use client';

import type { Market, Order, Outcome, Trade } from '@kynorix/contracts';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { TradeTicket } from '../../../components/TradeTicket';
import { formatAtoms, formatProbability, kynorixApi } from '../../../lib/api';

export default function MarketPage() {
  const { marketRef } = useParams<{ marketRef: string }>();
  const [market, setMarket] = useState<Market>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [book, setBook] = useState<Awaited<ReturnType<typeof kynorixApi.orderbook>>>();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const loadedMarket = market ?? (await kynorixApi.market(marketRef));
    const selected = outcome ?? loadedMarket.outcomes[0]!;
    const [nextBook, nextTrades, nextOrders] = await Promise.all([
      kynorixApi.orderbook(marketRef, selected.outcomeRef),
      kynorixApi.trades(marketRef),
      kynorixApi.orders(),
    ]);
    setMarket(loadedMarket);
    setOutcome(selected);
    setBook(nextBook);
    setTrades(nextTrades);
    setOrders(nextOrders.filter((order) => order.marketRef === marketRef));
  }, [market, marketRef, outcome]);

  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'Marknaden kunde inte hämtas'),
    );
  }, [refresh]);

  useEffect(() => {
    if (!market || !outcome) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');
    const channel = `market.${market.marketRef}.book`;
    const socket = new WebSocket(
      `${protocol}//${base.host}/v1/ws?channels=${encodeURIComponent(channel)}`,
    );
    socket.onmessage = () => void refresh();
    return () => socket.close();
  }, [market, outcome, refresh]);

  if (error) return <div className="state-card error standalone">{error}</div>;
  if (!market || !outcome) return <div className="state-card standalone">Hämtar marknaden…</div>;

  const bestAsk = book?.asks[0]?.priceAtoms;
  return (
    <div className="market-layout">
      <section className="market-main">
        <div className="market-title-block">
          <span className="category">{market.category}</span>
          <h1>{market.title}</h1>
          <p>{market.question}</p>
          <div className="market-meta">
            <span>
              <b>{formatProbability(bestAsk)}</b> JA-pris
            </span>
            <span>Stänger {new Date(market.closesAt).toLocaleDateString('sv-SE')}</span>
            <span>{market.status === 'open' ? 'Handel öppen' : market.status}</span>
          </div>
        </div>
        <div className="chart-card">
          <div className="chart-header">
            <div>
              <span className="eyebrow">Indikativ sannolikhet</span>
              <strong>{formatProbability(bestAsk)}</strong>
            </div>
            <span className="live-indicator">
              <span className="status-dot" /> Live orderbok
            </span>
          </div>
          <div className="mock-chart" aria-label="Indikativ prisgraf">
            <svg viewBox="0 0 800 260" preserveAspectRatio="none" role="img">
              <defs>
                <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#65f5c7" stopOpacity=".32" />
                  <stop offset="100%" stopColor="#65f5c7" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                className="chart-fill"
                d="M0 210 C80 190,105 160,180 175 S300 118,360 135 S455 82,520 100 S655 58,800 48 L800 260 L0 260 Z"
              />
              <path
                className="chart-line"
                d="M0 210 C80 190,105 160,180 175 S300 118,360 135 S455 82,520 100 S655 58,800 48"
              />
            </svg>
          </div>
        </div>

        <div className="market-data-grid">
          <section className="data-card">
            <div className="card-heading">
              <h2>Orderbok · {outcome.label}</h2>
              <span>Sekvens {book?.sequence ?? '—'}</span>
            </div>
            <div className="book-columns">
              <div>
                <div className="book-header">
                  <span>Köp</span>
                  <span>Antal</span>
                </div>
                {book?.bids.slice(0, 7).map((level) => (
                  <div className="book-row bid" key={level.priceAtoms}>
                    <span>{level.priceAtoms}%</span>
                    <span>{level.quantity}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="book-header">
                  <span>Sälj</span>
                  <span>Antal</span>
                </div>
                {book?.asks.slice(0, 7).map((level) => (
                  <div className="book-row ask" key={level.priceAtoms}>
                    <span>{level.priceAtoms}%</span>
                    <span>{level.quantity}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
          <section className="data-card">
            <div className="card-heading">
              <h2>Senaste avslut</h2>
              <span>Virtuell VSEK</span>
            </div>
            <div className="trade-list">
              {trades.length === 0 && <p className="muted">Inga avslut ännu.</p>}
              {trades.slice(0, 8).map((trade) => (
                <div className="trade-row" key={trade.tradeRef}>
                  <span>{trade.outcomeRef.endsWith('yes') ? 'JA' : 'NEJ'}</span>
                  <strong>{trade.priceAtoms}%</strong>
                  <span>{trade.quantity} st</span>
                  <span>{new Date(trade.executedAt).toLocaleTimeString('sv-SE')}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="rules-card">
          <span className="kicker">Resolution och bevis</span>
          <h2>Regler</h2>
          <p>{market.rules}</p>
          <a href={market.resolutionSource} target="_blank" rel="noreferrer">
            Öppna primär källa ↗
          </a>
          <dl>
            <div>
              <dt>Regelversion</dt>
              <dd>{market.immutableRuleVersion}</dd>
            </div>
            <div>
              <dt>Tidszon</dt>
              <dd>{market.displayTimezone}</dd>
            </div>
            <div>
              <dt>Collateral</dt>
              <dd>{market.collateralAsset}</dd>
            </div>
          </dl>
        </section>
      </section>
      <div className="market-side">
        <TradeTicket
          market={market}
          selectedOutcome={outcome}
          onOutcomeChange={(next) => {
            setOutcome(next);
            setBook(undefined);
          }}
          suggestedPrice={bestAsk}
          onPlaced={() => void refresh()}
        />
        <section className="compact-card">
          <h3>Dina order</h3>
          {orders.length === 0 && <p className="muted">Inga order på marknaden.</p>}
          {orders.slice(0, 4).map((order) => (
            <div className="compact-order" key={order.orderRef}>
              <div>
                <b>
                  {order.side === 'buy' ? 'Köp' : 'Sälj'}{' '}
                  {order.outcomeRef.endsWith('yes') ? 'JA' : 'NEJ'}
                </b>
                <span>{order.status}</span>
              </div>
              <strong>
                {order.remainingQuantity}/{order.quantity} · {order.priceAtoms}%
              </strong>
              {(order.status === 'open' || order.status === 'partially_filled') && (
                <button onClick={() => void kynorixApi.cancelOrder(order.orderRef).then(refresh)}>
                  Avbryt
                </button>
              )}
            </div>
          ))}
          <div className="balance-hint">
            Demoidentitet: Alex · {formatAtoms('1000000')} startkapital
          </div>
        </section>
      </div>
    </div>
  );
}
