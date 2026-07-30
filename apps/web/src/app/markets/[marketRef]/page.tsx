'use client';

import type {
  Market,
  MarketHistoryPoint,
  Order,
  Outcome,
  Position,
  Trade,
} from '@kynorix/contracts';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PriceChart } from '../../../components/PriceChart';
import { TradeTicket } from '../../../components/TradeTicket';
import { formatAtoms, formatDate, formatProbability, kynorixApi } from '../../../lib/api';

type Range = '1H' | '6H' | '1D' | '1W' | '1M' | 'ALL';

export default function MarketPage() {
  const { marketRef } = useParams<{ marketRef: string }>();
  const [market, setMarket] = useState<Market>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [book, setBook] = useState<Awaited<ReturnType<typeof kynorixApi.orderbook>>>();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [history, setHistory] = useState<MarketHistoryPoint[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [position, setPosition] = useState<Position>();
  const [range, setRange] = useState<Range>('1D');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const loadedMarket = market ?? (await kynorixApi.market(marketRef));
    const selected = outcome ?? loadedMarket.outcomes[0]!;
    const [nextBook, nextTrades, nextHistory] = await Promise.all([
      kynorixApi.orderbook(marketRef, selected.outcomeRef),
      kynorixApi.trades(marketRef),
      kynorixApi.history(marketRef, selected.outcomeRef, range),
    ]);
    const [nextOrders, nextPositions] = await Promise.all([
      kynorixApi.orders().catch(() => []),
      kynorixApi.positions().catch(() => []),
    ]);
    setMarket(loadedMarket);
    setOutcome(selected);
    setBook(nextBook);
    setTrades(nextTrades);
    setHistory(nextHistory);
    setOrders(nextOrders.filter((order) => order.marketRef === marketRef));
    setPosition(
      nextPositions.find(
        (value) => value.marketRef === marketRef && value.outcomeRef === selected.outcomeRef,
      ),
    );
  }, [market, marketRef, outcome, range]);

  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'Market could not be loaded.'),
    );
  }, [refresh]);

  if (error) return <div className="state-card error standalone">{error}</div>;
  if (!market || !outcome) return <div className="state-card standalone">Loading market…</div>;

  const bestAsk = book?.asks[0]?.priceAtoms ?? outcome.lastPriceAtoms ?? undefined;
  const live = market.status === 'open' && !market.tradingSuspended;
  return (
    <div className="market-layout">
      <section className="market-main">
        <div className="market-title-block">
          <span className="category">{market.category}</span>
          <h1>{market.title}</h1>
          <p>{market.question}</p>
          <div className="market-meta">
            <span>
              <b>{formatProbability(bestAsk)}</b> {outcome.label}
            </span>
            <span>Closes {formatDate(market.closesAt)}</span>
            <span>{live ? 'Trading open' : market.status.replaceAll('_', ' ')}</span>
          </div>
        </div>
        <div className="chart-card">
          <div className="chart-header">
            <div>
              <span className="eyebrow">Confirmed price</span>
              <strong>{formatProbability(bestAsk)}</strong>
            </div>
            <div className="range-row">
              {(['1H', '6H', '1D', '1W', '1M', 'ALL'] as Range[]).map((value) => (
                <button
                  className={range === value ? 'active' : ''}
                  key={value}
                  onClick={() => setRange(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
          <div className="history-chart">
            <PriceChart points={history} />
          </div>
        </div>
        <div className="market-data-grid">
          <section className="data-card">
            <div className="card-heading">
              <h2>Order book · {outcome.label}</h2>
              <span>Sequence {book?.sequence ?? '—'}</span>
            </div>
            <div className="book-columns">
              <BookSide title="Bids" levels={book?.bids ?? []} kind="bid" />
              <BookSide title="Asks" levels={book?.asks ?? []} kind="ask" />
            </div>
          </section>
          <section className="data-card">
            <div className="card-heading">
              <h2>Recent trades</h2>
              <span>{market.collateralAsset}</span>
            </div>
            <div className="trade-list">
              {trades.length === 0 && <p className="muted">No trades yet.</p>}
              {trades.slice(0, 10).map((trade) => (
                <div className="trade-row" key={trade.tradeRef}>
                  <span>
                    {market.outcomes.find((value) => value.outcomeRef === trade.outcomeRef)?.label}
                  </span>
                  <strong>{trade.priceAtoms}</strong>
                  <span>{trade.quantity}</span>
                  <span>
                    {new Date(trade.executedAt).toLocaleTimeString('en-US', { timeZone: 'UTC' })}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
        <section className="rules-card">
          <span className="kicker">Resolution and evidence</span>
          <h2>Market rules</h2>
          <p>{market.rules}</p>
          <a href={market.resolutionSource} target="_blank" rel="noreferrer">
            Open primary source ↗
          </a>
          <dl>
            <div>
              <dt>Rule version</dt>
              <dd>{market.immutableRuleVersion}</dd>
            </div>
            <div>
              <dt>Timezone</dt>
              <dd>{market.displayTimezone}</dd>
            </div>
            <div>
              <dt>Expected resolution</dt>
              <dd>{formatDate(market.resolutionTime)}</dd>
            </div>
          </dl>
        </section>
      </section>
      <div className="market-side">
        {live ? (
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
        ) : (
          <section className="compact-card">
            <h3>Trading unavailable</h3>
            <p>This market is currently {market.status.replaceAll('_', ' ')}.</p>
          </section>
        )}
        <section className="compact-card">
          <h3>Your position</h3>
          {position ? (
            <p>
              {position.availableQuantity} {position.outcomeLabel} ·{' '}
              {formatAtoms(
                position.positionValueAtoms,
                market.collateralAsset,
                market.assetDecimals,
              )}
            </p>
          ) : (
            <p className="muted">No position in this outcome.</p>
          )}
          <h3>Your orders</h3>
          {orders.length === 0 && <p className="muted">No orders in this market.</p>}
          {orders.slice(0, 6).map((order) => (
            <div className="compact-order" key={order.orderRef}>
              <div>
                <b>
                  {order.side}{' '}
                  {market.outcomes.find((value) => value.outcomeRef === order.outcomeRef)?.label}
                </b>
                <span>{order.status.replaceAll('_', ' ')}</span>
              </div>
              <strong>
                {order.remainingQuantity}/{order.quantity} · {order.priceAtoms}
              </strong>
              {(order.status === 'open' || order.status === 'partially_filled') && (
                <button onClick={() => void kynorixApi.cancelOrder(order.orderRef).then(refresh)}>
                  Cancel
                </button>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function BookSide({
  title,
  levels,
  kind,
}: {
  title: string;
  levels: Array<{ priceAtoms: string; quantity: string }>;
  kind: 'bid' | 'ask';
}) {
  return (
    <div>
      <div className="book-header">
        <span>{title}</span>
        <span>Quantity</span>
      </div>
      {levels.slice(0, 10).map((level) => (
        <div className={`book-row ${kind}`} key={level.priceAtoms}>
          <span>{level.priceAtoms}</span>
          <span>{level.quantity}</span>
        </div>
      ))}
      {levels.length === 0 && <p className="muted">No open orders.</p>}
    </div>
  );
}
