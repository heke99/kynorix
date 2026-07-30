'use client';

import type { Market, OrderSide, Outcome } from '@kynorix/contracts';
import { useMemo, useState } from 'react';
import { formatAtoms, kynorixApi } from '../lib/api';

export function TradeTicket({
  market,
  selectedOutcome,
  onOutcomeChange,
  suggestedPrice,
  onPlaced,
}: {
  market: Market;
  selectedOutcome: Outcome;
  onOutcomeChange: (outcome: Outcome) => void;
  suggestedPrice: string | undefined;
  onPlaced: () => void;
}) {
  const [side, setSide] = useState<OrderSide>('buy');
  const [price, setPrice] = useState(suggestedPrice ?? '50');
  const [quantity, setQuantity] = useState('10');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const total = useMemo(
    () => (Number(price || 0) * Number(quantity || 0)).toString(),
    [price, quantity],
  );

  async function submit() {
    setBusy(true);
    setMessage('');
    try {
      const order = await kynorixApi.placeOrder({
        marketRef: market.marketRef,
        outcomeRef: selectedOutcome.outcomeRef,
        side,
        type: 'limit',
        priceAtoms: price,
        quantity,
        timeInForce: 'GTC',
        postOnly: false,
        idempotencyKey: crypto.randomUUID(),
      });
      setMessage(
        `Order ${order.status === 'filled' ? 'fylld' : 'mottagen'} · ${order.orderRef.slice(0, 14)}…`,
      );
      onPlaced();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Ordern kunde inte skickas');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="trade-ticket">
      <div className="ticket-tabs">
        <button className={side === 'buy' ? 'active' : ''} onClick={() => setSide('buy')}>
          Köp
        </button>
        <button className={side === 'sell' ? 'active' : ''} onClick={() => setSide('sell')}>
          Sälj
        </button>
      </div>
      <div className="outcome-selector">
        {market.outcomes.map((outcome) => (
          <button
            key={outcome.outcomeRef}
            className={outcome.outcomeRef === selectedOutcome.outcomeRef ? 'active' : ''}
            onClick={() => onOutcomeChange(outcome)}
          >
            {outcome.label}
          </button>
        ))}
      </div>
      <label>
        Pris / sannolikhet
        <div className="input-suffix">
          <input
            inputMode="numeric"
            min="1"
            max="99"
            step="1"
            value={price}
            onChange={(event) => setPrice(event.target.value.replace(/\D/g, '').slice(0, 2))}
          />
          <span>%</span>
        </div>
      </label>
      <label>
        Antal kontrakt
        <input
          inputMode="numeric"
          min="1"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ''))}
        />
      </label>
      <div className="ticket-summary">
        <span>Ordervärde</span>
        <strong>{formatAtoms(total)}</strong>
        <span>Maximal utbetalning</span>
        <strong>{formatAtoms((Number(quantity || 0) * 100).toString())}</strong>
        <span>Avgift</span>
        <strong>visas i fill</strong>
      </div>
      <button className="primary-button" disabled={busy || !price || !quantity} onClick={submit}>
        {busy ? 'Skickar…' : `${side === 'buy' ? 'Köp' : 'Sälj'} ${selectedOutcome.label}`}
      </button>
      <p className="sandbox-note">Virtuella medel · inget kontantvärde · sandbox</p>
      {message && <div className="ticket-message">{message}</div>}
    </aside>
  );
}
